/**
 * Runtime configuration for the canary. All values come from environment
 * variables populated by Cloud Run from Secret Manager + job env.
 */

export type CanaryMode = "probe" | "digest";

export type CanaryConfig = {
  mode: CanaryMode;
  // Gloo AI credentials (from Secret Manager via runtime env)
  gloo: {
    clientId: string;
    clientSecret: string;
  };
  // Slack credentials (from Secret Manager via runtime env)
  slack: {
    botToken: string;
    channelId: string;
  };
  // GCS bucket where raw results + state are archived
  storage: {
    bucket: string;
  };
  // Execution identity — so the digest can correlate runs
  execution: {
    runId: string;
    startedAt: string;
  };
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function parseMode(raw: string | undefined): CanaryMode {
  if (raw === "probe" || raw === "digest") return raw;
  throw new Error(
    `CANARY_MODE must be "probe" or "digest" (received: ${raw ?? "unset"})`
  );
}

export function loadConfig(now: Date = new Date()): CanaryConfig {
  return {
    mode: parseMode(process.env.CANARY_MODE),
    gloo: {
      clientId: requireEnv("GLOO_AI_CLIENT_ID"),
      clientSecret: requireEnv("GLOO_AI_CLIENT_SECRET"),
    },
    slack: {
      botToken: requireEnv("ALERTS_SLACK_BOT_TOKEN"),
      channelId: requireEnv("ALERTS_SLACK_CHANNEL_ID"),
    },
    storage: {
      bucket: requireEnv("CANARY_RESULTS_BUCKET"),
    },
    execution: {
      runId:
        process.env.CLOUD_RUN_EXECUTION ??
        `local-${now.toISOString().replace(/[:.]/g, "-")}`,
      startedAt: now.toISOString(),
    },
  };
}
