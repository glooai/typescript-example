/**
 * Canary repro runner — manually reproduce a RED canary signature against
 * prod, on demand, using the *exact same request path* the scheduled probe
 * uses (`buildV2Probe` → OAuth → POST /ai/v2/chat/completions → `assessV2`).
 *
 * This is the standard "reproduce before you file" tool for Gloo AI canary
 * triage. When the triage skill surfaces a RED, run this against the failing
 * signature to confirm the failure is real (and not transient / self-
 * inflicted) and to capture the verbatim request + response envelope for an
 * RCA before any bug report is drafted.
 *
 * Usage (from canary/):
 *   tsx src/repro.ts <signature> [<signature> ...] [flags]
 *
 * Flags:
 *   --repeat <n>        Run each signature n times (default 1). Use for
 *                       retryable 5xx to measure how often it actually fails.
 *   --max-tokens <n>    Override every fixture's max_tokens with n. Use to
 *                       test the reasoning-model thinking-budget hypothesis
 *                       (see the 2026-04-27 max_tokens RCA).
 *   --no-max-tokens     Send no max_tokens at all (server default), to mirror
 *                       "casual usage" that often can't reproduce a budget bug.
 *   --list              Print every available signature and exit (no calls).
 *
 * Credentials come from env (`GLOO_AI_CLIENT_ID` / `GLOO_AI_CLIENT_SECRET`),
 * same as the probe runner. Never commit them; source them at call time.
 *
 * This module makes real, billed inference calls. Keep `--repeat` small.
 */

import { config as loadEnv } from "dotenv";
import { getAccessToken } from "@glooai/scripts";
import { buildV2Fixtures } from "./fixtures/index.js";

// Match the probe runner: hydrate creds from .env.local for local runs.
// dotenv does not override env vars already present, so creds exported at
// call time (the recommended path — source them, never commit them) win.
loadEnv({ path: ".env.local" });
import { buildV2Probe, type V2CompletionsFixture } from "./probes/v2-completions.js";
import type { ProbeContext, ProbeOutcome } from "./probes/types.js";

export type ReproOptions = {
  repeat: number;
  maxTokensOverride?: number;
  dropMaxTokens: boolean;
};

export type ReproArgs = {
  signatures: string[];
  options: ReproOptions;
  list: boolean;
};

/**
 * Parse argv (everything after `tsx src/repro.ts`). Pure + exported so it
 * can be unit-tested without spawning a process.
 */
export function parseArgs(argv: string[]): ReproArgs {
  const signatures: string[] = [];
  let repeat = 1;
  let maxTokensOverride: number | undefined;
  let dropMaxTokens = false;
  let list = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--repeat": {
        const next = argv[(i += 1)];
        const n = Number(next);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`--repeat expects a positive integer (got: ${next})`);
        }
        repeat = n;
        break;
      }
      case "--max-tokens": {
        const next = argv[(i += 1)];
        const n = Number(next);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(
            `--max-tokens expects a positive integer (got: ${next})`
          );
        }
        maxTokensOverride = n;
        break;
      }
      case "--no-max-tokens":
        dropMaxTokens = true;
        break;
      case "--list":
        list = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
        signatures.push(arg);
    }
  }

  return {
    signatures,
    options: { repeat, maxTokensOverride, dropMaxTokens },
    list,
  };
}

/**
 * Apply a max_tokens override / drop to a fixture without mutating the
 * original. Returns a copy so the rest of the fixture (prompt, routing,
 * timeout) stays byte-identical to what the scheduled probe sends.
 */
export function applyMaxTokens(
  fixture: V2CompletionsFixture,
  options: ReproOptions
): V2CompletionsFixture {
  if (options.dropMaxTokens) {
    const copy = { ...fixture };
    delete copy.maxTokens;
    return copy;
  }
  if (typeof options.maxTokensOverride === "number") {
    return { ...fixture, maxTokens: options.maxTokensOverride };
  }
  return fixture;
}

function summarize(outcome: ProbeOutcome): string {
  const lines = [
    `  verdict:   ${outcome.verdict} (${outcome.severity})`,
    `  http:      ${outcome.httpStatus ?? "network error"}`,
    `  latency:   ${outcome.durationMs}ms`,
    `  model:     ${outcome.model ?? "—"}`,
  ];
  if (outcome.responsePreview) {
    lines.push(`  response:  ${outcome.responsePreview}`);
  }
  if (outcome.details && Object.keys(outcome.details).length > 0) {
    lines.push(`  details:   ${JSON.stringify(outcome.details).slice(0, 1000)}`);
  }
  return lines.join("\n");
}

export async function main(argv: string[]): Promise<void> {
  const { signatures, options, list } = parseArgs(argv);

  const fixtures = await buildV2Fixtures();
  const bySignature = new Map(fixtures.map((f) => [f.signature, f]));

  if (list) {
    // eslint-disable-next-line no-console
    console.log([...bySignature.keys()].sort().join("\n"));
    return;
  }

  if (signatures.length === 0) {
    throw new Error(
      "No signatures given. Pass one or more (e.g. v2/model/gloo-deepseek-v3.2-speciale) or --list."
    );
  }

  const missing = signatures.filter((s) => !bySignature.has(s));
  if (missing.length > 0) {
    throw new Error(
      `Signature(s) not in the current registry-hydrated fixture set: ${missing.join(", ")}. Run --list to see valid signatures.`
    );
  }

  const clientId = process.env.GLOO_AI_CLIENT_ID;
  const clientSecret = process.env.GLOO_AI_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing GLOO_AI_CLIENT_ID / GLOO_AI_CLIENT_SECRET in env."
    );
  }

  const tokenResponse = await getAccessToken({ clientId, clientSecret });
  const accessToken = tokenResponse.access_token;
  if (!accessToken) {
    throw new Error("Access token missing from Gloo token response.");
  }

  const ctx: ProbeContext = {
    accessToken,
    runId: `repro-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    startedAt: new Date().toISOString(),
  };

  // eslint-disable-next-line no-console
  console.log(
    `Repro: ${signatures.length} signature(s) × ${options.repeat} run(s)` +
      (options.dropMaxTokens
        ? " · max_tokens: <server default>"
        : typeof options.maxTokensOverride === "number"
          ? ` · max_tokens: ${options.maxTokensOverride}`
          : " · max_tokens: <fixture default>") +
      `\nRun id: ${ctx.runId}\n`
  );

  for (const signature of signatures) {
    const fixture = applyMaxTokens(bySignature.get(signature)!, options);
    const probe = buildV2Probe(fixture);
    const verdicts: string[] = [];

    // eslint-disable-next-line no-console
    console.log(`\n=== ${signature} (${fixture.label}) ===`);
    // eslint-disable-next-line no-console
    console.log(
      `request body: ${JSON.stringify({
        max_tokens: fixture.maxTokens,
        routing: fixture.routing,
      })}`
    );

    for (let attempt = 1; attempt <= options.repeat; attempt += 1) {
      const outcome = await probe.run(ctx);
      verdicts.push(`${outcome.httpStatus ?? "ERR"}/${outcome.verdict}`);
      // eslint-disable-next-line no-console
      console.log(`\n[attempt ${attempt}/${options.repeat}]`);
      // eslint-disable-next-line no-console
      console.log(summarize(outcome));
    }

    if (options.repeat > 1) {
      // eslint-disable-next-line no-console
      console.log(`\n  ↳ ${signature} tally: ${verdicts.join(", ")}`);
    }
  }
}

// Only run when invoked directly (tsx src/repro.ts), not when imported by a test.
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("repro.ts");
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`repro failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
