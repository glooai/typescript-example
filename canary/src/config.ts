/**
 * Runtime configuration for the canary. All values come from environment
 * variables populated by Cloud Run from Secret Manager + job env.
 */

export type CanaryMode = "probe" | "digest" | "ingestion";

export type IngestionConfig = {
  /** Dedicated canary publisher (must belong to the canary client's org). */
  publisherId: string;
  /** End-to-end processing budget before SLA_EXCEEDED (RED). */
  slaMs: number;
  pollIntervalMs: number;
};

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
  // Only populated in ingestion mode.
  ingestion?: IngestionConfig;
  /**
   * Better Stack heartbeat URL for this job's component (set per Cloud
   * Run Job: the probe job carries the Inference heartbeat, the
   * ingestion job the Data Engine one). Absent → heartbeats disabled.
   */
  heartbeatUrl?: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function parseMode(raw: string | undefined): CanaryMode {
  if (raw === "probe" || raw === "digest" || raw === "ingestion") return raw;
  throw new Error(
    `CANARY_MODE must be "probe", "digest", or "ingestion" (received: ${raw ?? "unset"})`
  );
}

function optionalPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number (received: ${raw})`);
  }
  return value;
}

export function loadConfig(now: Date = new Date()): CanaryConfig {
  const mode = parseMode(process.env.CANARY_MODE);
  return {
    mode,
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
    ...(process.env.CANARY_HEARTBEAT_URL
      ? { heartbeatUrl: process.env.CANARY_HEARTBEAT_URL }
      : {}),
    ...(mode === "ingestion"
      ? {
          ingestion: {
            publisherId: requireEnv("CANARY_INGESTION_PUBLISHER_ID"),
            slaMs: optionalPositiveInt("CANARY_INGESTION_SLA_MS", 600_000),
            pollIntervalMs: optionalPositiveInt(
              "CANARY_INGESTION_POLL_INTERVAL_MS",
              15_000
            ),
          },
        }
      : {}),
  };
}
