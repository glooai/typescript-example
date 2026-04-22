/**
 * Probe fixtures — the surface area we're fuzzing. Each fixture becomes one
 * Probe instance. Extend this file (not the runner) to add coverage.
 *
 * Source of truth for V2 direct-model aliases AND family routing values:
 * the live unauthenticated endpoint
 *   GET https://platform.ai.gloo.com/platform/v2/models
 *
 * That's the same data feed the public supported-models docs page renders
 * from (see `TangoGroup/gloo#2049` — Mintlify was switched to pull from
 * this endpoint dynamically so docs can't drift from the platform registry
 * again). Hydrating the probe list at run time — instead of keeping a
 * checked-in mirror — means the canary can never drift either: retired
 * models disappear from our probes the same minute they disappear from
 * the registry, and new families start getting probed the same minute
 * they first show up.
 *
 * Scope:
 *   - V2 Completions is the actively supported surface. We probe every
 *     direct-model alias returned by the live registry PLUS every
 *     routing mode the router exposes. `auto_routing` is a single
 *     static fixture (it's a boolean flag, not a family). The
 *     `model_family` probes are derived dynamically from the distinct
 *     `family` values in the registry.
 *   - V1 Messages is deprecated and maintained for backwards-compat only.
 *     Per Gloo platform team (2026-04-21 triage thread, CC Elio Kazu
 *     Mostero + Jackson Southern): V1 has no cross-provider retry chain
 *     and individual models like `Llama 3 70B Instruct` are explicitly
 *     labeled deprecated in `ai-api`. We deliberately do NOT probe V1 —
 *     every failure would be a design-expected flake, not a platform
 *     outage signal. If a caller needs reliability, they should migrate
 *     to V2.
 */

import type { V1MessagesFixture } from "../probes/v1-messages.js";
import type { V2CompletionsFixture } from "../probes/v2-completions.js";
import { fetchV2Models, type V2ModelSummary } from "./v2-models.js";

// Benign tech-writing prompt — matches the refusal-regression pattern we
// want to keep detecting (see scripts/tests/completions-v2-moderation for
// the external bug report that motivated these probes). Short answer keeps
// per-probe latency low.
const BENIGN_PROMPT =
  "In one sentence, what are three best practices for clear technical writing?";

// Some models (GPT-5.2 Pro, Opus 4.6, DeepSeek R1 with reasoning) can run
// longer than the default 90s — give every direct-model probe 120s so the
// per-probe timeout isn't the bottleneck. Probes still run sequentially so
// the whole batch completes well under the 600s job timeout.
const V2_DIRECT_PROBE_TIMEOUT_MS = 120_000;

// Cap full-sweep probe responses at ~48 tokens (comfortably fits the
// benign reply plus any refusal prefix the detector needs to match)
// — the router + model-selection + safety layer all execute even with
// a short cap, so coverage is preserved while inference spend drops
// materially. See `.context/guides/gloo/api/completions-v2.md` for
// the `max_tokens` contract.
const V2_FULL_PROBE_MAX_TOKENS = 48;

// Pulse-probe prompt — the single probe we fire in the "light" tier
// every 15 min. Minimizes input token budget while still exercising
// auth → router → completion. The benign-prompt reuse would also
// work, but a single-word prompt keeps input billed-weight as low as
// it can go without drifting from realistic usage.
const LIGHT_PULSE_PROMPT = "ping";

// Light-tier cap. The pulse probe doesn't depend on content inspection
// (any 2xx with non-empty `choices[0].message.content` counts as PASS
// — benign:false turns off the refusal detector so we can't
// false-positive a truncated reply). Keep this as small as the
// refusal detector + schema validator both tolerate.
const V2_LIGHT_PROBE_MAX_TOKENS = 4;

/**
 * V1 Messages probes are intentionally empty. V1 is deprecated by design
 * and probing it generates red-herring RED alerts for expected-flaky
 * provider-side behavior. Kept as an empty export so the runner wiring
 * stays stable if we ever decide to add a targeted V1 probe back (for
 * example, a dedicated "confirm V1 returns 'model not supported' after a
 * retirement date" alarm that only alerts on the specific retirement
 * verdict, not on transient 503s).
 */
export const V1_FIXTURES: V1MessagesFixture[] = [];

/**
 * `auto_routing: true` isn't tied to any specific model or family, so
 * it's declared statically. If the platform ever removes auto_routing
 * as a mechanism, this probe turning RED is the signal.
 */
export const V2_AUTO_ROUTING_FIXTURE: V2CompletionsFixture = {
  signature: "v2/auto_routing",
  label: "V2 · auto_routing",
  prompt: BENIGN_PROMPT,
  benign: true,
  maxTokens: V2_FULL_PROBE_MAX_TOKENS,
  routing: { kind: "auto_routing" },
};

/**
 * Light-tier "pulse" fixture. Exactly one probe, fired on the every-15-min
 * schedule when no failures are active and a full sweep has happened
 * recently. Exercises the full production path (OAuth → router →
 * completion) with the minimum possible request + response weight so
 * steady-state inference spend is measured in single-digit tokens per
 * run.
 *
 * Detection semantics:
 *  - Platform-wide outage (OAuth down, router down, all providers down)
 *    → light probe fails → next scheduled run escalates to Full tier
 *    within 15 min. Well under the 1h awareness target.
 *  - Single-model or single-family outage → NOT caught here (router
 *    dodges unhealthy backends). Covered by the periodic Full sweep
 *    (see `CANARY_FULL_SWEEP_INTERVAL_MS`, default 1h).
 *
 * `benign: false` turns off the refusal detector — a 4-token response
 * can't reasonably be inspected for refusal patterns without false
 * positives, and any non-empty 2xx already proves the full completion
 * path worked. Schema validation + empty-content check still apply.
 */
export const V2_LIGHT_PULSE_FIXTURE: V2CompletionsFixture = {
  signature: "v2/light/auto_routing",
  label: "V2 · light pulse · auto_routing",
  prompt: LIGHT_PULSE_PROMPT,
  benign: false,
  maxTokens: V2_LIGHT_PROBE_MAX_TOKENS,
  routing: { kind: "auto_routing" },
};

/**
 * Canonical slug form of a family name for probe signatures. Always
 * lowercase, spaces to hyphens — "Open Source" → "open-source". Stable
 * as long as the registry keeps the same family names, and deterministic
 * without needing a manual mapping table.
 */
export function familySlug(family: string): string {
  return family.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Distinct family names present in a V2 models response. Output is
 * sorted for stable Slack/stdout ordering and de-duped. Pulls the
 * canonical casing straight from the registry — so the fixture's
 * `model_family` request body stays in lock-step with whatever the
 * server currently accepts, even if Gloo adjusts casing over time.
 */
export function extractFamilies(models: V2ModelSummary[]): string[] {
  const set = new Set<string>();
  for (const m of models) {
    if (m.family && m.family.trim().length > 0) {
      set.add(m.family);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Build one `model_family=<family>` fixture per distinct family in the
 * registry. Previously this list was hardcoded to {Anthropic, Google,
 * OpenAI, Open Source} — the current registry values at the time the
 * canary was written. Hardcoding meant a new family (e.g. "Mistral",
 * "xAI") would be silently skipped until somebody manually updated the
 * fixture list. Deriving from the registry closes that gap.
 *
 * Signatures use `familySlug()` so Slack + digest output keep the
 * same slugs ("v2/family/anthropic", "v2/family/open-source") we had
 * before. Labels use the canonical casing for human readability.
 */
export function buildV2FamilyFixtures(
  families: string[]
): V2CompletionsFixture[] {
  return families
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .map(
      (family): V2CompletionsFixture => ({
        signature: `v2/family/${familySlug(family)}`,
        label: `V2 · model_family=${family}`,
        prompt: BENIGN_PROMPT,
        benign: true,
        maxTokens: V2_FULL_PROBE_MAX_TOKENS,
        routing: { kind: "model_family", family },
      })
    );
}

/**
 * Build the Full-tier routing fixtures from a models response.
 * `auto_routing` is always present; `model_family` fixtures are
 * derived from the distinct `family` values in the registry.
 */
export function buildV2RoutingFixtures(
  models: V2ModelSummary[]
): V2CompletionsFixture[] {
  return [
    V2_AUTO_ROUTING_FIXTURE,
    ...buildV2FamilyFixtures(extractFamilies(models)),
  ];
}

/**
 * Build one direct-model fixture per entry in a V2 models response.
 *
 * Signatures are derived deterministically from the model id — `v2/model/<id>`
 * — so they stay stable as long as the platform keeps the id stable, and
 * so we never need a manual slug-mapping table. Labels come straight from
 * the registry's `name` field, which is the same string the Studio Model
 * Explorer shows.
 */
export function buildV2DirectModelFixtures(
  models: V2ModelSummary[]
): V2CompletionsFixture[] {
  return models
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (model): V2CompletionsFixture => ({
        signature: `v2/model/${model.id}`,
        label: `V2 · ${model.name}`,
        prompt: BENIGN_PROMPT,
        benign: true,
        timeoutMs: V2_DIRECT_PROBE_TIMEOUT_MS,
        maxTokens: V2_FULL_PROBE_MAX_TOKENS,
        routing: { kind: "model", model: model.id },
      })
    );
}

export type BuildV2FixturesDeps = {
  /** Injectable for tests — defaults to the live `/platform/v2/models` fetch. */
  loadModels?: () => Promise<V2ModelSummary[]>;
};

/**
 * Routing-mode probes (auto_routing + 1 per distinct family in the
 * registry) + one direct-model probe per model in the registry. Async
 * because the whole list is hydrated live on every Full-tier run.
 */
export async function buildV2Fixtures(
  deps: BuildV2FixturesDeps = {}
): Promise<V2CompletionsFixture[]> {
  const loadModels = deps.loadModels ?? (() => fetchV2Models());
  const models = await loadModels();
  return [
    ...buildV2RoutingFixtures(models),
    ...buildV2DirectModelFixtures(models),
  ];
}

/**
 * Signatures the canary is *currently* intended to probe given a
 * snapshot of the live registry. Includes V1 (currently empty),
 * the light-pulse signature, `v2/auto_routing`, one
 * `v2/family/<slug>` per distinct family, and one `v2/model/<id>`
 * per model. The digest uses this to filter archived outcomes for
 * signatures that are no longer in the probe set — e.g.,
 * retired-from-registry aliases or families whose old runs still
 * sit in the 24h window. One definition, one call site, no drift
 * between the probe build path and the digest filter path.
 *
 * Takes `modelIds` + `families` (rather than the fuller
 * `V2ModelSummary[]`) so the digest can call it directly with the
 * GCS snapshot blob, which only stores those two fields. `families`
 * is optional to tolerate older snapshots written before the field
 * was added — callers pass `undefined` (or omit it) and the family
 * slice returns empty, so the digest fall-open behavior for legacy
 * snapshots is preserved.
 */
export function currentProbeSignatures(
  modelIds: string[],
  families: string[] = []
): string[] {
  const v1 = V1_FIXTURES.map((f) => f.signature);
  const light = [V2_LIGHT_PULSE_FIXTURE.signature];
  const routing = [
    V2_AUTO_ROUTING_FIXTURE.signature,
    ...families
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((f) => `v2/family/${familySlug(f)}`),
  ];
  const direct = modelIds.map((id) => `v2/model/${id}`);
  return [...v1, ...light, ...routing, ...direct];
}
