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
  expect(parseMode("ingestion")).toBe("ingestion");
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

const INGESTION_ENV = {
  CANARY_MODE: "ingestion",
  GLOO_AI_CLIENT_ID: "id",
  GLOO_AI_CLIENT_SECRET: "secret",
  ALERTS_SLACK_BOT_TOKEN: "xoxb-fake",
  ALERTS_SLACK_CHANNEL_ID: "C123",
  CANARY_RESULTS_BUCKET: "bucket",
  CANARY_INGESTION_PUBLISHER_ID: "pub-1",
};

it("requires CANARY_INGESTION_PUBLISHER_ID in ingestion mode", () => {
  process.env = { ...INGESTION_ENV };
  delete process.env.CANARY_INGESTION_PUBLISHER_ID;
  expect(() => loadConfig()).toThrow(/CANARY_INGESTION_PUBLISHER_ID/);
});

it("builds ingestion config with defaults", () => {
  process.env = { ...INGESTION_ENV };
  const cfg = loadConfig();
  expect(cfg.mode).toBe("ingestion");
  expect(cfg.ingestion).toEqual({
    publisherId: "pub-1",
    slaMs: 600_000,
    pollIntervalMs: 15_000,
  });
});

it("honors ingestion SLA/poll overrides and rejects non-numeric values", () => {
  process.env = {
    ...INGESTION_ENV,
    CANARY_INGESTION_SLA_MS: "120000",
    CANARY_INGESTION_POLL_INTERVAL_MS: "5000",
  };
  const cfg = loadConfig();
  expect(cfg.ingestion?.slaMs).toBe(120_000);
  expect(cfg.ingestion?.pollIntervalMs).toBe(5_000);

  process.env.CANARY_INGESTION_SLA_MS = "ten minutes";
  expect(() => loadConfig()).toThrow(/CANARY_INGESTION_SLA_MS/);
});

it("does not require or attach ingestion config in probe mode", () => {
  process.env = { ...INGESTION_ENV, CANARY_MODE: "probe" };
  delete process.env.CANARY_INGESTION_PUBLISHER_ID;
  const cfg = loadConfig();
  expect(cfg.ingestion).toBeUndefined();
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
