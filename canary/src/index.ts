/**
 * Cloud Run Job entry point. Selects between probe and digest modes based on
 * the CANARY_MODE env var populated by Terraform.
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createGcsClient } from "./sinks/gcs.js";
import { createSlackClient } from "./sinks/slack.js";
import { buildV1Probe } from "./probes/v1-messages.js";
import { buildV2Probe } from "./probes/v2-completions.js";
import {
  V1_FIXTURES,
  buildV2DirectModelFixtures,
  V2_ROUTING_FIXTURES,
} from "./fixtures/index.js";
import { fetchV2Models } from "./fixtures/v2-models.js";
import { runProbes } from "./runners/probe-runner.js";
import { runDigest } from "./runners/digest-runner.js";

export async function main(): Promise<void> {
  const config = loadConfig();
  const gcs = createGcsClient(config.storage.bucket);
  const slack = createSlackClient(
    config.slack.botToken,
    config.slack.channelId
  );

  if (config.mode === "probe") {
    // Hydrate the V2 probe list from the authoritative model registry on
    // every run — if `/platform/v2/models` is unreachable this throws and
    // the job exits non-zero, which is the correct behavior: a canary
    // running zero direct-model probes is strictly less useful than one
    // that fails loudly and surfaces the outage in Cloud Run logs.
    //
    // Fetch ONCE, then fan the same list out to both (a) the probe-fixture
    // builder and (b) the GCS-backed registry-snapshot + diff pipeline.
    // Avoids a second round-trip to /platform/v2/models on every run.
    const v2Models = await fetchV2Models();
    const v2Fixtures = [
      ...V2_ROUTING_FIXTURES,
      ...buildV2DirectModelFixtures(v2Models),
    ];
    const probes = [
      ...V1_FIXTURES.map(buildV1Probe),
      ...v2Fixtures.map(buildV2Probe),
    ];

    const artifact = await runProbes(config, {
      probes,
      gcs,
      slack,
      v2Models,
    });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: "info",
        msg: "probe run complete",
        runId: artifact.runId,
        outcomes: artifact.outcomes.length,
        red: artifact.outcomes.filter((o) => o.severity === "RED").length,
        registryDelta: artifact.registryDelta
          ? {
              added: artifact.registryDelta.added.length,
              removed: artifact.registryDelta.removed.length,
              isFirstSnapshot: artifact.registryDelta.isFirstSnapshot,
            }
          : null,
      })
    );
    return;
  }

  if (config.mode === "digest") {
    const summary = await runDigest(config, { gcs, slack });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: "info",
        msg: "digest run complete",
        runsFound: summary.runsFound,
        probesRun: summary.probesRun,
        severity: summary.severityCounts,
      })
    );
    return;
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
