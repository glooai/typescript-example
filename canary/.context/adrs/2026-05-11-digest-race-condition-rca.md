---
type: postmortem
status: resolved
created: 2026-05-11
tags: [canary, gloo-ai, digest, scheduler, race-condition, rca]
---

# RCA — Weekly digest posted "no probes registered" on 2026-05-11 despite active probe run

## TL;DR

The canary's digest CronJob fired at 06:05 CT on Monday 2026-05-11, five
minutes after the probe job started at 06:00 CT. A full weekly sweep takes
up to ~10 minutes end-to-end (OAuth → per-probe HTTP calls → GCS write).
The digest's `loadWindow` query ran while the probe was still executing —
before its GCS run artifact was committed — so the 24h window contained
zero artifacts. The digest posted a green-circle top-level with
`*(no probes registered)*` to `#alerts-glooai`, which made the situation
look like a configuration failure rather than a scheduling race.

Simultaneously, a live RED alert for `v2/model/gloo-mistral-large-3` (HTTP
503, provider unavailable) posted to the same channel 12 seconds after the
digest, proving that the probe was running and correctly detecting failures —
it had just not yet finished writing to GCS when the digest queried.

**Fix shipped in this PR:** digest cron moved from `5 6 * * 1` → `15 6 * * 1`
(06:15 CT Monday). Digest copy improved to distinguish "no run artifacts in
window" from "no probes configured."

---

## What happened

### Timeline (all times CT / UTC-5, 2026-05-11)

| Time (CT) | Event |
|---|---|
| 06:00 CT | Cloud Scheduler fires `canary-probe-6h` Cloud Run Job |
| 06:01 CT | Probe job starts; Mistral Large 3 fails with HTTP 503 at 06:01:43 CT |
| 06:05 CT | Cloud Scheduler fires `canary-digest-daily` Cloud Run Job |
| 06:06:38 CT | `runDigest` calls `loadWindow` — probe GCS write not yet complete → 0 artifacts |
| 06:06:38 CT | Digest posts `:large_green_circle: *Gloo AI Canary — 24h Digest*` with `Probes run: 0` and `(no probes registered)` |
| 06:06:55 CT | Probe job finishes; GCS artifact written; RED alert for Mistral posted to Slack |

The digest and the RED alert appear 12 seconds apart in `#alerts-glooai`.
The digest arrived first.

### Why the window was empty

`loadWindow` (in `digest-runner.ts`) builds GCS prefix strings for the past
26 hours and calls `gcs.list(prefix)` for each. With a weekly probe schedule
(`0 6 * * 1`), there is at most one probe run in any 24h window — the Monday
morning run. That run had not yet written its GCS artifact when `loadWindow`
executed. Result: `artifacts = []`.

When `artifacts` is empty, `summarize` returns:
- `windowStart = now.toISOString()` (fallback from `artifacts[0]?.startedAt`)
- `windowEnd = now.toISOString()`
- `runsFound = 0`, `probesRun = 0`, `perProbe = []`

The `formatDigestTopLevel` path then hit the `perProbe.length === 0` branch
and rendered the string `_(no probes registered)_`, which was written to
describe the "no probes configured" case — not "no probe runs found."

### Contributing factor: schedule change

A recent refactor reduced probe frequency from 57/day → 4/day → 1/week
(the 1/week landing is in the commit just before this one). The comment in
`variables.tf` explicitly noted the design intent:

```
# 06:05 CT Monday — 5 minutes after the 06:00 probe so the digest sees fresh data
```

The assumption was that "5 minutes" gives the probe enough runway. It did
not — a Full sweep that hits every registered direct-model alias takes
roughly 8–10 minutes end-to-end when some providers are slow (Mistral was
503ing at ~600ms; other models may take longer). The original 57/day
schedule meant there was always prior-run data in GCS from the last 15 min,
so the race window was invisible. With weekly runs the race window is
exposed every Monday.

---

## Technical chain

1. Cloud Scheduler fires `canary-probe-6h` at `0 6 * * 1` (06:00 CT).
2. `index.ts` calls `buildV2Fixtures()` (fetches live `/platform/v2/models`),
   determines Full tier, passes all probes to `runProbes()`.
3. Probes execute sequentially — auth, then one HTTP call per probe.
4. After all probes complete, `runProbes` calls
   `gcs.writeJson(runArtifactPath(runId, now), artifact)` (line ~100,
   `probe-runner.ts`). This is the only point at which the run is durable.
5. Cloud Scheduler fires `canary-digest-daily` at `5 6 * * 1` (06:05 CT).
6. `runDigest` calls `loadWindow(gcs, now)`, which enumerates GCS prefixes
   for the past 26h. The step-4 write has not completed yet → no artifacts.
7. `summarize([], …)` returns all-zero counts.
8. `formatDigestTopLevel` renders `_(no probes registered)_` because
   `summary.perProbe.length === 0`.
9. Digest posts the misleading all-green message.
10. Step-4 write completes; `reconcileFailures` posts the RED alert for
    Mistral.

---

## Why this looked alarming

The green-circle emoji on the digest header (`🟢 *Gloo AI Canary — 24h Digest*`)
combined with `Probes run: 0` and `(no probes registered)` closely resembles
what you'd see if the probe fixtures were wiped or the scheduler was
misconfigured. The real signal — a live Mistral 503 — appeared in the same
channel 12 seconds later, but the juxtaposition was confusing: a "healthy"
digest followed immediately by a RED alert.

---

## Fixes shipped in this PR

### 1. Digest cron: `5 6 * * 1` → `15 6 * * 1`

`canary/terraform/envs/prod/variables.tf`:

```
default = "15 6 * * 1"
```

15 minutes gives the probe a comfortable margin even if individual probes
run slowly (reasoning models at 2048 max_tokens, Mistral 503s that still
consume the full probe timeout, etc.). The weekly digest loses 10 minutes
of freshness in exchange for always seeing the Monday run's results.

### 2. Clearer "no runs in window" copy

`canary/src/runners/digest-runner.ts`, `formatDigestTopLevel`:

Before:
```
_(no probes registered)_
```

After (when `runsFound === 0`):
```
_(no probe runs found in the last 24h — check that the probe scheduler is running)_
```

This distinguishes:
- `runsFound === 0` → scheduler / timing issue
- `runsFound > 0` but `perProbe.length === 0` → all outcomes filtered by
  `allowedSignatures` (retired model cleanup, first-deploy edge case)
- `perProbe.length > 0` but no notable probes → all green

---

## Forward-looking guards

These are NOT shipped in this PR but are worth follow-up issues:

1. **Extend the digest window to 7 days.** `WINDOW_HOURS = 24` made sense
   when the probe ran 57×/day. With a weekly schedule, the digest's 24h
   window will always contain at most one run — the morning probe. A 168h
   window would give the digest a full week of history to summarize, making
   it genuinely useful as a "weekly recap" rather than just a "this morning"
   snapshot. This requires updating `WINDOW_HOURS` and re-checking the
   archival prune math (currently `90d` GCS lifecycle — still fine).

2. **Add a watchdog alert for digest silence.** If `runsFound === 0` on a
   weekly digest, post a `:rotating_light:` instead of a `:large_green_circle:`
   so the channel scan is unambiguous. The digest currently inherits its
   header emoji from `severityCounts.RED > 0` — a zero-run digest always
   renders green, even when it should page.

3. **Consider a probe health-check in a separate channel / PD integration.**
   The current alerting model is entirely in-band (Slack only). A probe or
   digest outage silences the channel rather than paging someone. Even a
   simple "no digest posted in 8 days" Cloud Monitoring alert would catch
   the next scheduler misconfiguration before a week of silence.

---

## What this RCA is NOT

- Not a platform outage. The probe correctly detected Mistral's 503 and
  posted the RED alert. The Gloo platform was partly degraded (Mistral
  unavailable), not the canary.
- Not a code bug in `loadWindow`, `summarize`, or `reconcileFailures`. All
  three behaved correctly given the inputs. The scheduler gap is the root
  cause.
- Not a regression introduced by the weekly-frequency change itself. The
  race existed at 4×/day too — it was just statistically unlikely because
  old GCS artifacts from earlier that day were always in the window.

---

## References

- Slack alert (digest, 06:06:38 CT):
  https://servant-io.slack.com/archives/C0AU2FM2Q86/p1778497627594169
- Slack alert (Mistral RED, 06:06:55 CT):
  https://servant-io.slack.com/archives/C0AU2FM2Q86/p1778497615800719
- `digest-runner.ts` — `loadWindow`, `summarize`, `formatDigestTopLevel`
- `probe-runner.ts` — `runProbes` (GCS write precedes Slack post)
- Scheduler Terraform: `canary/terraform/envs/prod/scheduler.tf`
- Schedule variables: `canary/terraform/envs/prod/variables.tf`
- Prior RCA (reasoning-model max_tokens):
  `canary/.context/adrs/2026-04-27-reasoning-model-max-tokens-rca.md`
