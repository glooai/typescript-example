import { afterEach, beforeEach, expect, it } from "vitest";
import { loadConfig, parseMode } from "../src/config.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

it("parses canary modes", () => {
  expect(parseMode("probe")).toBe("probe");
  expect(parseMode("digest")).toBe("digest");
  expect(() => parseMode("nope")).toThrow(/CANARY_MODE/);
  expect(() => parseMode(undefined)).toThrow(/CANARY_MODE/);
});

it("requires every runtime env var", () => {
  process.env = {};
  expect(() => loadConfig()).toThrow(/CANARY_MODE/);
});

it("builds a config from all env vars when present", () => {
  process.env = {
    CANARY_MODE: "probe",
    GLOO_AI_CLIENT_ID: "id",
    GLOO_AI_CLIENT_SECRET: "secret",
    ALERTS_SLACK_BOT_TOKEN: "xoxb-fake",
    ALERTS_SLACK_CHANNEL_ID: "C123",
    CANARY_RESULTS_BUCKET: "bucket",
    CLOUD_RUN_EXECUTION: "canary-probe-exec-abc",
  };
  const cfg = loadConfig(new Date("2026-04-20T12:00:00Z"));
  expect(cfg.mode).toBe("probe");
  expect(cfg.gloo).toEqual({ clientId: "id", clientSecret: "secret" });
  expect(cfg.slack).toEqual({ botToken: "xoxb-fake", channelId: "C123" });
  expect(cfg.storage.bucket).toBe("bucket");
  expect(cfg.execution.runId).toBe("canary-probe-exec-abc");
  expect(cfg.execution.startedAt).toBe("2026-04-20T12:00:00.000Z");
});

it("falls back to a synthetic runId when CLOUD_RUN_EXECUTION is unset", () => {
  process.env = {
    CANARY_MODE: "digest",
    GLOO_AI_CLIENT_ID: "id",
    GLOO_AI_CLIENT_SECRET: "secret",
    ALERTS_SLACK_BOT_TOKEN: "xoxb-fake",
    ALERTS_SLACK_CHANNEL_ID: "C123",
    CANARY_RESULTS_BUCKET: "bucket",
  };
  const cfg = loadConfig(new Date("2026-04-20T12:00:00Z"));
  expect(cfg.execution.runId).toBe("local-2026-04-20T12-00-00-000Z");
});
