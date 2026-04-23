import { expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  formatConfirmedRecovery,
  formatFailureTopLevel,
  reconcileFailures,
} from "../../src/runners/probe-runner.js";
import type {
  ActiveFailures,
  GcsClient,
  RunArtifact,
} from "../../src/sinks/gcs.js";
import type { SlackClient } from "../../src/sinks/slack.js";
import type { ProbeOutcome } from "../../src/probes/types.js";
import type { CanaryConfig } from "../../src/config.js";

const NOW = new Date("2026-04-20T18:00:00Z");

const CONFIG: CanaryConfig = {
  mode: "probe",
  gloo: { clientId: "id", clientSecret: "s" },
  slack: { botToken: "xoxb", channelId: "C" },
  storage: { bucket: "b" },
  execution: { runId: "run-abc", startedAt: NOW.toISOString() },
};

function makeOutcome(partial: Partial<ProbeOutcome>): ProbeOutcome {
  return {
    signature: "v1/test",
    label: "V1 · test",
    endpoint: "https://example.com",
    apiVersion: "v1",
    httpStatus: 200,
    verdict: "PASS",
    severity: "GREEN",
    durationMs: 100,
    details: {},
    completedAt: Math.floor(NOW.getTime() / 1000),
    ...partial,
  };
}

function fakeGcs(initial: {
  activeFailures?: ActiveFailures;
}): GcsClient & { writes: Map<string, unknown> } {
  const writes = new Map<string, unknown>();
  return {
    writes,
    async writeJson(path, payload) {
      writes.set(path, payload);
    },
    async readJson<T>(path: string): Promise<T | null> {
      if (path === "state/active-failures.json") {
        return (initial.activeFailures ?? null) as T | null;
      }
      return null;
    },
    async list() {
      return [];
    },
    async getMetadata() {
      return null;
    },
  };
}

function fakeSlack(): SlackClient & {
  posts: Array<{ text: string; threadTs?: string }>;
  reactions: Array<{ ts: string; emoji: string }>;
  updates: Array<{ ts: string; text: string }>;
} {
  let ts = 1700000000;
  const posts: Array<{ text: string; threadTs?: string }> = [];
  const reactions: Array<{ ts: string; emoji: string }> = [];
  const updates: Array<{ ts: string; text: string }> = [];
  return {
    posts,
    reactions,
    updates,
    async post({ text, threadTs }) {
      posts.push({ text, threadTs });
      ts += 1;
      return { ts: `${ts}.000000`, channel: "C" };
    },
    async react(tsVal, emoji) {
      reactions.push({ ts: tsVal, emoji });
    },
    async update({ ts: tsVal, text }) {
      updates.push({ ts: tsVal, text });
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Opening an incident ---------------------------------------------------

it("posts a single top-level alert when a new RED signature appears", async () => {
  const gcs = fakeGcs({});
  const slack = fakeSlack();
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({
        signature: "v1/sonnet-4",
        verdict: "FAIL",
        severity: "RED",
        httpStatus: 500,
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  expect(slack.posts).toHaveLength(1);
  expect(slack.posts[0].threadTs).toBeUndefined();
  expect(slack.posts[0].text).toContain("Canary RED");
  // topLevelText stashed for future confirmed-recovery chat.update.
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v1/sonnet-4"].attempts).toBe(1);
  expect(state["v1/sonnet-4"].topLevelText).toContain("Canary RED");
});

// --- Recurring failures are SILENT ----------------------------------------

it("stays silent on a recurring failure — state updates only, no Slack post", async () => {
  // Core anti-spam rule. While an incident is open the user should
  // hear about it exactly once (plus the daily digest). No threaded
  // "still failing" updates on each probe cycle.
  const gcs = fakeGcs({
    activeFailures: {
      "v1/sonnet-4": {
        firstSeenAt: "2026-04-20T14:00:00Z",
        lastSeenAt: "2026-04-20T14:00:00Z",
        slackTs: "1700000001.000000",
        attempts: 1,
        lastVerdict: "FAIL",
        topLevelText: ":rotating_light: *Canary RED — V1 · sonnet-4*",
      },
    },
  });
  const slack = fakeSlack();
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({
        signature: "v1/sonnet-4",
        verdict: "FAIL",
        severity: "RED",
        httpStatus: 500,
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  expect(slack.posts).toHaveLength(0);
  expect(slack.updates).toHaveLength(0);
  expect(slack.reactions).toHaveLength(0);
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v1/sonnet-4"].attempts).toBe(2);
  expect(state["v1/sonnet-4"].lastSeenAt).toBe(NOW.toISOString());
  // slackTs preserved so the eventual confirmed-recovery post threads onto it.
  expect(state["v1/sonnet-4"].slackTs).toBe("1700000001.000000");
});

// --- Recovery is DEBOUNCED ------------------------------------------------

it("first pass after a failure is silent — starts the debounce window", async () => {
  const gcs = fakeGcs({
    activeFailures: {
      "v1/sonnet-4": {
        firstSeenAt: "2026-04-20T14:00:00Z",
        lastSeenAt: "2026-04-20T14:00:00Z",
        slackTs: "1700000001.000000",
        attempts: 5,
        lastVerdict: "FAIL",
        topLevelText: ":rotating_light: *Canary RED — V1 · sonnet-4*",
      },
    },
  });
  const slack = fakeSlack();
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({
        signature: "v1/sonnet-4",
        verdict: "PASS",
        severity: "GREEN",
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  expect(slack.posts).toHaveLength(0);
  expect(slack.updates).toHaveLength(0);
  expect(slack.reactions).toHaveLength(0);
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  // Entry preserved with recoveredAt set — awaits debounce confirmation.
  expect(state["v1/sonnet-4"].recoveredAt).toBe(NOW.toISOString());
  expect(state["v1/sonnet-4"].slackTs).toBe("1700000001.000000");
});

it("publishes the confirmed-recovery post + banner + reaction once the debounce elapses", async () => {
  // 61 min since first-pass → debounce (60 min) has elapsed.
  const FIRST_PASS_AT = "2026-04-20T16:59:00Z";
  const gcs = fakeGcs({
    activeFailures: {
      "v1/sonnet-4": {
        firstSeenAt: "2026-04-20T14:00:00Z",
        lastSeenAt: FIRST_PASS_AT,
        slackTs: "1700000001.000000",
        attempts: 5,
        lastVerdict: "PASS",
        topLevelText:
          ":rotating_light: *Canary RED — V1 · sonnet-4*\n• *Verdict:* FAIL",
        recoveredAt: FIRST_PASS_AT,
      },
    },
  });
  const slack = fakeSlack();
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({
        signature: "v1/sonnet-4",
        verdict: "PASS",
        severity: "GREEN",
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  // One threaded recovery post, referencing the first-pass time so the
  // on-caller can see how long the thing was actually healed.
  expect(slack.posts).toHaveLength(1);
  expect(slack.posts[0].threadTs).toBe("1700000001.000000");
  expect(slack.posts[0].text).toContain("Recovered");
  expect(slack.posts[0].text).toContain(FIRST_PASS_AT);
  // Reaction + banner edit on the original top-level so the channel
  // overview reflects the closed incident at a glance.
  expect(slack.reactions).toEqual([
    { ts: "1700000001.000000", emoji: "white_check_mark" },
  ]);
  expect(slack.updates).toHaveLength(1);
  expect(slack.updates[0].ts).toBe("1700000001.000000");
  expect(slack.updates[0].text).toContain(":white_check_mark:");
  expect(slack.updates[0].text).toContain("*Recovered*");
  // State is retired on confirmed recovery.
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v1/sonnet-4"]).toBeUndefined();
});

it("stays silent while still inside the debounce window", async () => {
  // Only 30 min since first-pass — debounce (60 min) has NOT elapsed.
  const FIRST_PASS_AT = "2026-04-20T17:30:00Z";
  const gcs = fakeGcs({
    activeFailures: {
      "v1/sonnet-4": {
        firstSeenAt: "2026-04-20T14:00:00Z",
        lastSeenAt: FIRST_PASS_AT,
        slackTs: "1700000001.000000",
        attempts: 5,
        lastVerdict: "PASS",
        topLevelText: ":rotating_light: *Canary RED — V1 · sonnet-4*",
        recoveredAt: FIRST_PASS_AT,
      },
    },
  });
  const slack = fakeSlack();
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({
        signature: "v1/sonnet-4",
        verdict: "PASS",
        severity: "GREEN",
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  expect(slack.posts).toHaveLength(0);
  expect(slack.updates).toHaveLength(0);
  expect(slack.reactions).toHaveLength(0);
  // State preserved, recoveredAt unchanged (still debouncing).
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v1/sonnet-4"].recoveredAt).toBe(FIRST_PASS_AT);
});

// --- Flapping snaps back to "open" silently -------------------------------

it("silently reopens a debouncing signature on a re-failure — no Slack spam", async () => {
  // Flap: FAIL (opened earlier) → PASS (started debounce) → FAIL again.
  // Before the debounce fix this produced a 2nd top-level post OR a
  // threaded "Reopened" reply on every cycle. Now it's fully silent:
  // just clear recoveredAt, bump attempts, and the incident stays
  // open under the original top-level post.
  const FIRST_PASS_AT = "2026-04-20T17:45:00Z";
  const gcs = fakeGcs({
    activeFailures: {
      "v2/family/open-source": {
        firstSeenAt: "2026-04-20T17:30:00Z",
        lastSeenAt: FIRST_PASS_AT,
        slackTs: "1700000001.000000",
        attempts: 2,
        lastVerdict: "PASS",
        topLevelText: ":rotating_light: *Canary RED — V2 · Open Source*",
        recoveredAt: FIRST_PASS_AT,
      },
    },
  });
  const slack = fakeSlack();
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({
        signature: "v2/family/open-source",
        verdict: "FAIL",
        severity: "RED",
        httpStatus: 503,
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  expect(slack.posts).toHaveLength(0);
  expect(slack.updates).toHaveLength(0);
  expect(slack.reactions).toHaveLength(0);
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v2/family/open-source"].recoveredAt).toBeUndefined();
  expect(state["v2/family/open-source"].attempts).toBe(3);
  expect(state["v2/family/open-source"].slackTs).toBe("1700000001.000000");
});

// --- New incident AFTER a confirmed recovery ------------------------------

it("treats a fresh failure as a new incident after the state entry has been retired", async () => {
  // After confirmed recovery the state entry is deleted. A subsequent
  // failure for the same signature is a brand-new incident and gets
  // its own top-level post.
  const gcs = fakeGcs({
    activeFailures: {}, // state was retired on a prior confirmed recovery
  });
  const slack = fakeSlack();
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({
        signature: "v2/family/open-source",
        verdict: "FAIL",
        severity: "RED",
        httpStatus: 503,
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  expect(slack.posts).toHaveLength(1);
  expect(slack.posts[0].threadTs).toBeUndefined();
  expect(slack.posts[0].text).toContain("Canary RED");
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v2/family/open-source"].attempts).toBe(1);
});

// --- Backcompat + failure resilience --------------------------------------

it("confirmed recovery survives when the legacy state entry has no topLevelText", async () => {
  // State blobs written before `topLevelText` was added must not crash
  // the recovery path — we skip chat.update but still post the thread
  // reply + add the reaction, and clean up state.
  const FIRST_PASS_AT = "2026-04-20T16:59:00Z";
  const gcs = fakeGcs({
    activeFailures: {
      "v1/legacy": {
        firstSeenAt: "2026-04-20T14:00:00Z",
        lastSeenAt: FIRST_PASS_AT,
        slackTs: "1700000001.000000",
        attempts: 3,
        lastVerdict: "PASS",
        recoveredAt: FIRST_PASS_AT,
        // topLevelText intentionally omitted
      },
    },
  });
  const slack = fakeSlack();
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({
        signature: "v1/legacy",
        verdict: "PASS",
        severity: "GREEN",
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  expect(slack.posts[0].text).toContain("Recovered");
  expect(slack.reactions).toHaveLength(1);
  expect(slack.updates).toHaveLength(0); // no topLevelText → skip
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v1/legacy"]).toBeUndefined();
});

it("a failed chat.update does not block the confirmed-recovery cleanup", async () => {
  const FIRST_PASS_AT = "2026-04-20T16:59:00Z";
  const gcs = fakeGcs({
    activeFailures: {
      "v1/update-blocked": {
        firstSeenAt: "2026-04-20T14:00:00Z",
        lastSeenAt: FIRST_PASS_AT,
        slackTs: "1700000001.000000",
        attempts: 1,
        lastVerdict: "PASS",
        topLevelText: "original failure text",
        recoveredAt: FIRST_PASS_AT,
      },
    },
  });
  const slack: SlackClient & {
    posts: Array<{ text: string; threadTs?: string }>;
  } = {
    posts: [],
    async post({ text, threadTs }) {
      this.posts.push({ text, threadTs });
      return { ts: "x", channel: "C" };
    },
    async react() {},
    async update() {
      throw new Error("missing_scope");
    },
  };
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({
        signature: "v1/update-blocked",
        verdict: "PASS",
        severity: "GREEN",
      }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  // State cleaned up despite the chat.update failure — we still posted
  // the thread reply, so the incident is logically closed.
  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state["v1/update-blocked"]).toBeUndefined();
});

it("keeps reconciling + persisting state when a top-level post throws", async () => {
  // Before the original fix, a single slack.post() failure would bubble
  // out of reconcileFailures and abort the state-file write — causing
  // every previously-alerted failure to re-post as new on the next run.
  const gcs = fakeGcs({});
  let postCallCount = 0;
  const slack: SlackClient & { posts: Array<{ text: string }> } = {
    posts: [],
    async post({ text }) {
      postCallCount++;
      if (postCallCount === 1) {
        throw new Error("slack rate_limited");
      }
      this.posts.push({ text });
      return { ts: "1700000000.000001", channel: "C" };
    },
    async react() {},
    async update() {},
  };
  const artifact: RunArtifact = {
    runId: "run-abc",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    outcomes: [
      makeOutcome({ signature: "v1/flaky", verdict: "FAIL", severity: "RED" }),
      makeOutcome({ signature: "v1/ok", verdict: "FAIL", severity: "RED" }),
    ],
  };

  await reconcileFailures(artifact, { probes: [], gcs, slack }, CONFIG, NOW);

  const state = gcs.writes.get("state/active-failures.json") as ActiveFailures;
  expect(state).toBeDefined();
  expect(state["v1/ok"]).toBeDefined();
  // The failed post is NOT in state — next run treats it as new and retries.
  expect(state["v1/flaky"]).toBeUndefined();
});

// --- Formatting helpers ---------------------------------------------------

it("formats top-level failure posts with the signature + metadata", () => {
  const text = formatFailureTopLevel(
    makeOutcome({
      signature: "v1/sonnet-4",
      verdict: "FAIL",
      severity: "RED",
      httpStatus: 500,
      responsePreview: '{"detail":"Error generating response."}',
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    }),
    CONFIG
  );
  expect(text).toContain("Canary RED");
  expect(text).toContain("v1/sonnet-4");
  expect(text).toContain("HTTP status:* 500");
  expect(text).toContain("us.anthropic.claude-sonnet-4");
});

it("surfaces contentPreview over responsePreview for REFUSAL_REGRESSION alerts", () => {
  const text = formatFailureTopLevel(
    makeOutcome({
      verdict: "REFUSAL_REGRESSION",
      severity: "RED",
      httpStatus: 200,
      responsePreview:
        '{"choices":[{"message":{"content":"I cant help with that. Unsafe drug use is dangerous."}}]}',
      contentPreview: "I cant help with that. Unsafe drug use is dangerous.",
    }),
    CONFIG
  );
  expect(text).toContain("Content:");
  expect(text).toContain("I cant help with that");
  expect(text).not.toContain("Response:");
});

it("falls back to responsePreview when no contentPreview (5xx / schema failures)", () => {
  const text = formatFailureTopLevel(
    makeOutcome({
      verdict: "FAIL",
      severity: "RED",
      httpStatus: 503,
      responsePreview: '{"detail":"upstream unavailable"}',
      contentPreview: null,
    }),
    CONFIG
  );
  expect(text).toContain("Response:");
  expect(text).toContain("upstream unavailable");
  expect(text).not.toContain("Content:");
});

it("formatConfirmedRecovery references both the first-pass time and the confirmation time", () => {
  const text = formatConfirmedRecovery(
    "v2/family/open-source",
    "2026-04-20T16:59:00Z",
    new Date("2026-04-20T18:00:00Z")
  );
  expect(text).toContain(":white_check_mark:");
  expect(text).toContain("Recovered");
  expect(text).toContain("v2/family/open-source");
  expect(text).toContain("2026-04-20T16:59:00Z");
  // `new Date(...).toISOString()` uses millisecond precision.
  expect(text).toContain("2026-04-20T18:00:00.000Z");
});
