/**
 * Cloud Run Job entry point. Selects between probe, digest, and ingestion
 * modes based on the CANARY_MODE env var populated by Terraform.
 *
 * Ingestion mode runs a single end-to-end Data Engine pipeline probe
 * (submit → poll status → verify retrievable → delete) on its own
 * schedule, with failure state isolated from the inference canary's —
 * see `probes/ingestion.ts`.
 *
 * Probe-mode execution is tiered:
 *   - LIGHT: single `auto_routing` pulse probe. Cheapest possible check
 *     that still exercises OAuth → router → completion. Runs every
 *     scheduler tick when the platform is healthy. Detection window
 *     for platform-wide outages: one tick (≤15 min daytime).
 *   - FULL : every routing-mode + every direct-model probe. Runs on
 *     cold start, any active failure, and at least once per
 *     `CANARY_FULL_SWEEP_INTERVAL_MS` window (default 1h). Detection
 *     window for single-model outages: ≤1h.
 * See `runners/tier-decision.ts` for the selection rules.
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { loadConfig, type CanaryConfig } from "./config.js";
import {
  createGcsClient,
  INGESTION_ACTIVE_FAILURES_PATH,
  type GcsClient,
  type RunArtifact,
} from "./sinks/gcs.js";
import { createSlackClient, type SlackClient } from "./sinks/slack.js";
import { buildV1Probe } from "./probes/v1-messages.js";
import { buildV2Probe } from "./probes/v2-completions.js";
import { buildIngestionProbe } from "./probes/ingestion.js";
import {
  V1_FIXTURES,
  V2_LIGHT_PULSE_FIXTURE,
  buildV2DirectModelFixtures,
  buildV2RoutingFixtures,
} from "./fixtures/index.js";
import { fetchV2Models } from "./fixtures/v2-models.js";
import { runProbes } from "./runners/probe-runner.js";
import { runDigest } from "./runners/digest-runner.js";
import {
  loadAndDecideTier,
  resolveFullSweepIntervalMs,
} from "./runners/tier-decision.js";

type Sinks = {
  gcs: GcsClient;
  slack: SlackClient;
};

function logJson(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: "info", ...payload }));
}

async function runProbeMode(
  config: CanaryConfig,
  { gcs, slack }: Sinks
): Promise<void> {
  // Decide the tier BEFORE any network call. Light tier skips the
  // `/platform/v2/models` fetch entirely and runs exactly one completion -
  // the whole point of the adaptive design is that the happy path is as
  // cheap as we can make it.
  const now = new Date();
  const decision = await loadAndDecideTier(
    gcs,
    now,
    resolveFullSweepIntervalMs(process.env.CANARY_FULL_SWEEP_INTERVAL_MS)
  );

  if (decision.tier === "light") {
    // No registry snapshot on Light runs - the periodic Full sweep handles
    // that, and it is at most an hour away by definition.
    const artifact = await runProbes(config, {
      probes: [buildV2Probe(V2_LIGHT_PULSE_FIXTURE)],
      gcs,
      slack,
      tier: "light",
    });
    logJson({
      msg: "probe run complete",
      tier: "light",
      decisionReason: decision.reason,
      runId: artifact.runId,
      outcomes: artifact.outcomes.length,
      red: countRed(artifact),
    });
    return;
  }

  // Full tier. If `/platform/v2/models` is unreachable this throws and the
  // job exits non-zero, which is correct: a canary running zero
  // direct-model probes is strictly less useful than one that fails loudly
  // in the Cloud Run logs. Fetched once and fanned out to both the fixture
  // builder and the registry-snapshot pipeline.
  const v2Models = await fetchV2Models();
  const v2Fixtures = [
    ...buildV2RoutingFixtures(v2Models),
    ...buildV2DirectModelFixtures(v2Models),
  ];

  const artifact = await runProbes(config, {
    probes: [...V1_FIXTURES.map(buildV1Probe), ...v2Fixtures.map(buildV2Probe)],
    gcs,
    slack,
    v2Models,
    tier: "full",
  });
  logJson({
    msg: "probe run complete",
    tier: "full",
    decisionReason: decision.reason,
    runId: artifact.runId,
    outcomes: artifact.outcomes.length,
    red: countRed(artifact),
    registryDelta: artifact.registryDelta
      ? {
          added: artifact.registryDelta.added.length,
          removed: artifact.registryDelta.removed.length,
          isFirstSnapshot: artifact.registryDelta.isFirstSnapshot,
        }
      : null,
  });
}

function countRed(artifact: RunArtifact): number {
  return artifact.outcomes.filter((o) => o.severity === "RED").length;
}

async function runIngestionMode(
  config: CanaryConfig,
  { gcs, slack }: Sinks
): Promise<void> {
  if (!config.ingestion) {
    throw new Error("ingestion config missing in ingestion mode");
  }
  // One end-to-end journey per firing. Failure state and tier bookkeeping
  // are isolated from the inference canary: an ingestion run knows nothing
  // about model signatures and must not touch their incident lifecycle.
  const artifact = await runProbes(config, {
    probes: [
      buildIngestionProbe({
        signature: "ingestion/v2/e2e-text-file",
        label: "Ingestion E2E · text file (submit → status → snippets)",
        publisherId: config.ingestion.publisherId,
        slaMs: config.ingestion.slaMs,
        pollIntervalMs: config.ingestion.pollIntervalMs,
      }),
    ],
    gcs,
    slack,
    activeFailuresPath: INGESTION_ACTIVE_FAILURES_PATH,
    persistTierState: false,
  });
  const outcome = artifact.outcomes[0];
  logJson({
    msg: "ingestion run complete",
    runId: artifact.runId,
    verdict: outcome?.verdict,
    severity: outcome?.severity,
    durationMs: outcome?.durationMs,
    itemId: outcome?.details.itemId ?? null,
  });
}

async function runDigestMode(
  config: CanaryConfig,
  { gcs, slack }: Sinks
): Promise<void> {
  const summary = await runDigest(config, { gcs, slack });
  logJson({
    msg: "digest run complete",
    runsFound: summary.runsFound,
    probesRun: summary.probesRun,
    severity: summary.severityCounts,
  });
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const sinks: Sinks = {
    gcs: createGcsClient(config.storage.bucket),
    slack: createSlackClient(config.slack.botToken, config.slack.channelId),
  };

  switch (config.mode) {
    case "probe":
      return runProbeMode(config, sinks);
    case "ingestion":
      return runIngestionMode(config, sinks);
    case "digest":
      return runDigestMode(config, sinks);
  }
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  loadEnv({ path: ".env.local" });
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: "error",
        msg: "canary run failed",
        error: (error as Error).message,
        stack: (error as Error).stack,
      })
    );
    process.exit(1);
  });
}
