import { expect, it, vi } from "vitest";
import {
  buildWatchdogPrefixes,
  runWatchdog,
  WATCHDOG_WINDOW_HOURS,
} from "../../src/runners/watchdog-runner.js";
import type { GcsClient } from "../../src/sinks/gcs.js";
import type { SlackClient } from "../../src/sinks/slack.js";
import type { CanaryConfig } from "../../src/config.js";

// Wednesday 07:00 UTC — typical watchdog fire time
const NOW = new Date("2026-04-22T07:00:00Z");

function makeGcs(files: string[] = []): GcsClient {
  return {
    list: vi.fn().mockResolvedValue(files),
    readJson: vi.fn().mockResolvedValue(null),
    writeJson: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue(null),
  };
}

function makeSlack(): SlackClient {
  return {
    post: vi.fn().mockResolvedValue({ ts: "ts-001", channel: "C123" }),
    react: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  };
}

const STUB_CONFIG = {
  mode: "watchdog" as const,
  gloo: { clientId: "id", clientSecret: "secret" },
  slack: { botToken: "token", channelId: "C123" },
  storage: { bucket: "test-bucket" },
  execution: { runId: "test", startedAt: NOW.toISOString() },
} satisfies CanaryConfig;

// ---------------------------------------------------------------------------
// buildWatchdogPrefixes
// ---------------------------------------------------------------------------

it("covers the full 192h (8-day) window with daily GCS prefixes", () => {
  const prefixes = buildWatchdogPrefixes(NOW, WATCHDOG_WINDOW_HOURS);
  // 192h = 8 days. Window starts 2026-04-14T07:00Z → first day prefix = 2026/04/14
  // Current day (2026-04-22) is also included → 9 prefixes total
  expect(prefixes.length).toBe(9);
  expect(prefixes[0]).toBe("runs/2026/04/14/");
  expect(prefixes[prefixes.length - 1]).toBe("runs/2026/04/22/");
});

it("includes the boundary date 8 days ago (probe day is Monday)", () => {
  // NOW = Wednesday 2026-04-22; 8 days back = 2026-04-14 (Monday)
  const prefixes = buildWatchdogPrefixes(NOW, WATCHDOG_WINDOW_HOURS);
  expect(prefixes).toContain("runs/2026/04/14/");
  expect(prefixes).toContain("runs/2026/04/21/"); // last Monday (1 day ago)
});

it("returns only one prefix per day (no duplicates)", () => {
  const prefixes = buildWatchdogPrefixes(NOW, WATCHDOG_WINDOW_HOURS);
  const unique = new Set(prefixes);
  expect(unique.size).toBe(prefixes.length);
});

// ---------------------------------------------------------------------------
// runWatchdog — healthy path
// ---------------------------------------------------------------------------

it("logs probe_healthy and does NOT post to Slack when artifacts are found", async () => {
  const gcs = makeGcs(["runs/2026/04/21/06-abc.json"]);
  const slack = makeSlack();

  const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  const summary = await runWatchdog(STUB_CONFIG, { gcs, slack });

  // makeGcs returns the same file for every prefix, so count = #prefixes × 1.
  // We only care that artifacts were found (> 0), not the exact count.
  expect(summary.artifactsFound).toBeGreaterThan(0);
  expect(summary.newestArtifact).not.toBeNull();

  // Slack must NOT be called on healthy runs
  expect(slack.post).not.toHaveBeenCalled();

  // Structured log must include event: "probe_healthy"
  const logCall = consoleSpy.mock.calls[0]?.[0];
  expect(logCall).toBeDefined();
  const parsed = JSON.parse(logCall as string) as { event: string };
  expect(parsed.event).toBe("probe_healthy");

  consoleSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// runWatchdog — probe_missed path
// ---------------------------------------------------------------------------

it("logs probe_missed and posts Slack alert when GCS is empty", async () => {
  const gcs = makeGcs([]); // no artifacts in any day prefix
  const slack = makeSlack();

  const consoleErrorSpy = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  const summary = await runWatchdog(STUB_CONFIG, { gcs, slack });

  expect(summary.artifactsFound).toBe(0);
  expect(summary.newestArtifact).toBeNull();

  // Must emit the Cloud Monitoring sentinel log
  const errCall = consoleErrorSpy.mock.calls[0]?.[0];
  expect(errCall).toBeDefined();
  const parsed = JSON.parse(errCall as string) as {
    event: string;
    level: string;
    windowHours: number;
  };
  expect(parsed.event).toBe("probe_missed");
  expect(parsed.level).toBe("error");
  expect(parsed.windowHours).toBe(WATCHDOG_WINDOW_HOURS);

  // Must post Slack alert containing the rotating_light emoji
  expect(slack.post).toHaveBeenCalledOnce();
  const postArg = (slack.post as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
    text: string;
  };
  expect(postArg.text).toContain(":rotating_light:");
  expect(postArg.text).toContain("silent for 8+ days");

  consoleErrorSpy.mockRestore();
});

it("lists every prefix built by buildWatchdogPrefixes (no missed days)", async () => {
  const listMock = vi.fn().mockResolvedValue([]);
  const gcs: GcsClient = {
    list: listMock,
    readJson: vi.fn().mockResolvedValue(null),
    writeJson: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue(null),
  };
  const slack = makeSlack();
  vi.spyOn(console, "error").mockImplementation(() => {});

  await runWatchdog(STUB_CONFIG, { gcs, slack });

  // list() called once per day prefix in the 8-day window
  expect(listMock).toHaveBeenCalledTimes(9); // 8 days + current day
});
