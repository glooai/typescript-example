/**
 * Repro: `model_family` string variants on Gloo Completions V2.
 *
 * Motivation:
 *   Our 24h canary digest for 2026-04-20 showed one intermittent HTTP 422
 *   for the `open-source` family against V2 Completions while the other
 *   7 runs in the same window succeeded with the canonical title-cased
 *   form the canary sends today (`"Open Source"`). Keane (Gloo) reported
 *   deterministic behavior: `"open-source"` (hyphen) fails 30/30,
 *   `"open source"` (space, lower) passes 10/10. That contradicted our
 *   intermittent observation and prompted a race-condition hypothesis on
 *   the canary side.
 *
 *   This script is a self-contained, orchestration-free reproducer that
 *   exercises every interesting `model_family` string form and tallies
 *   200 vs 4xx behavior so both sides can compare notes apples-to-apples.
 *   Sequential calls only — no concurrency, no retries, no shared state.
 *
 * Resolution (2026-04-21, documented here so future readers don't re-chase
 * the race-condition hypothesis):
 *   The "non-determinism" was an artifact of three different Cloud Run Job
 *   image digests cycling through during the canary's first-day rollout.
 *   `gcloud run jobs executions describe` on the five affected executions
 *   showed:
 *     - 20:15 UTC ran `afca64b6...` = tag `2ec3953` — fixture
 *       `family: "open-source"` (hyphen, pre-production draft) → 422
 *     - 20:22 UTC ran `5571e644...` = tag `5c72760` — fixture
 *       `family: "Open Source"` (corrected casing) → passed
 *     - 20:45 UTC onward ran `4dd74826...` = tag `b384cef` — fixture
 *       `family: "Open Source"` (PR-merged production pin) → passed
 *   Gloo's validator is deterministic. The one 422 was a stale image
 *   running the pre-production fixture for a single cron tick. No Gloo
 *   bug, no canary race condition — just a first-day image-pin transient.
 *   This script is kept so anyone on either side can re-run the same
 *   variant sweep against the live API in under a minute.
 *
 * Usage:
 *   pnpm glooai:model-family-repro              # 10 iterations per variant
 *   pnpm glooai:model-family-repro 30           # 30 iterations per variant
 *
 *   Reads GLOO_CLIENT_ID / GLOO_CLIENT_SECRET from `.env.local` at the
 *   monorepo root.
 */

import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCredentials, getAccessToken } from "./auth.js";

// Load .env.local from the monorepo root so the script works whether
// pnpm invokes it from the repo root or from scripts/.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = resolve(MODULE_DIR, "../../.env.local");

export const V2_URL = "https://platform.ai.gloo.com/ai/v2/chat/completions";

/**
 * Every `model_family` string form worth exercising. The canary uses
 * "Open Source" (canonical casing from Gloo's own error-response accepted-
 * values list). The others cover each adjacent form we've seen mentioned
 * in the bug-triage conversation plus a couple of shape variants a caller
 * might realistically stumble into.
 */
export const MODEL_FAMILY_VARIANTS: readonly string[] = [
  "Open Source",
  "open source",
  "OPEN SOURCE",
  "open-source",
  "Open-Source",
  "OpenSource",
  "open_source",
] as const;

export const REPRO_PROMPT = "ping";

/**
 * Request body minus the `model_family` field, which varies per call.
 * Kept as a factory so tests can assert on the full shape without
 * mutating a shared object.
 */
export function buildBody(family: string): Record<string, unknown> {
  return {
    messages: [{ role: "user", content: REPRO_PROMPT }],
    auto_routing: false,
    model_family: family,
    max_tokens: 20,
  };
}

export type CallResult = {
  status: number;
  passed: boolean;
  routedModel?: string;
  echoedFamily?: string;
  traceId?: string;
  /** First ~200 chars of the raw body, for the "other" statuses we don't parse. */
  bodyPreview?: string;
};

/**
 * Extract the interesting fields from both success (routed model) and
 * failure (echoed family + trace id) response shapes. Parsing is defensive
 * because Gloo has several error envelopes (V2 422 Pydantic-style vs. the
 * platform-level 4xx/5xx error envelope); we probe both.
 */
export function parseResponse(text: string): {
  routedModel?: string;
  echoedFamily?: string;
  traceId?: string;
} {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof body !== "object" || body === null) return {};

  const record = body as Record<string, unknown>;

  // Success envelope: { choices: [...], model: "...", ... }
  const routedModel =
    typeof record.model === "string" ? record.model : undefined;

  // Pydantic 422 envelope: { detail: [ { input: { model_family }, ... } ] }
  let echoedFamily: string | undefined;
  const detail = record.detail;
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0] as Record<string, unknown>;
    const input = first.input as Record<string, unknown> | undefined;
    if (input && typeof input.model_family === "string") {
      echoedFamily = input.model_family;
    }
  }

  // Platform 4xx envelope: { error: { trace_id, ... } }
  let traceId: string | undefined;
  const error = record.error as Record<string, unknown> | undefined;
  if (error && typeof error.trace_id === "string") {
    traceId = error.trace_id;
  }
  if (!traceId && Array.isArray(detail)) {
    const first = detail[0] as Record<string, unknown>;
    if (typeof first.trace_id === "string") traceId = first.trace_id;
  }

  return { routedModel, echoedFamily, traceId };
}

export async function callOnce(
  accessToken: string,
  family: string,
  fetchImpl: typeof fetch = fetch
): Promise<CallResult> {
  const response = await fetchImpl(V2_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(buildBody(family)),
  });
  const text = await response.text();
  const parsed = parseResponse(text);
  return {
    status: response.status,
    passed: response.status >= 200 && response.status < 300,
    ...parsed,
    bodyPreview: parsed.echoedFamily ? undefined : text.slice(0, 200),
  };
}

export type VariantSummary = {
  variant: string;
  calls: number;
  passed: number;
  failed: number;
  statusHistogram: Record<number, number>;
  routedModels: string[];
  echoedFamilies: string[];
  firstTraceId?: string;
};

export function summarize(
  variant: string,
  results: readonly CallResult[]
): VariantSummary {
  const statusHistogram: Record<number, number> = {};
  const routedModels = new Set<string>();
  const echoedFamilies = new Set<string>();
  let firstTraceId: string | undefined;
  let passed = 0;
  for (const result of results) {
    statusHistogram[result.status] = (statusHistogram[result.status] ?? 0) + 1;
    if (result.passed) passed++;
    if (result.routedModel) routedModels.add(result.routedModel);
    if (result.echoedFamily) echoedFamilies.add(result.echoedFamily);
    if (!firstTraceId && result.traceId) firstTraceId = result.traceId;
  }
  return {
    variant,
    calls: results.length,
    passed,
    failed: results.length - passed,
    statusHistogram,
    routedModels: Array.from(routedModels),
    echoedFamilies: Array.from(echoedFamilies),
    firstTraceId,
  };
}

export function formatSummaryLine(summary: VariantSummary): string {
  const statusParts = Object.entries(summary.statusHistogram)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([code, count]) => `${code}×${count}`)
    .join(" ");
  const routed =
    summary.routedModels.length > 0 ? summary.routedModels.join(",") : "-";
  const echoed =
    summary.echoedFamilies.length > 0
      ? summary.echoedFamilies.map((value) => JSON.stringify(value)).join(",")
      : "-";
  const mixedMarker =
    summary.passed > 0 && summary.failed > 0
      ? "  [MIXED, non-deterministic]"
      : "";
  const padded = JSON.stringify(summary.variant).padEnd(16);
  return `${padded}  ${summary.passed}/${summary.calls} pass  status:${statusParts}  routed:${routed}  echoed-family:${echoed}${mixedMarker}`;
}

export async function runRepro(
  iterations: number,
  writeLine: (line: string) => void = console.log
): Promise<VariantSummary[]> {
  const credentials = loadCredentials();
  const tokenResponse = await getAccessToken(credentials);
  const accessToken = tokenResponse.access_token;
  if (!accessToken) {
    throw new Error("Access token missing from Gloo token response.");
  }

  const summaries: VariantSummary[] = [];
  for (const variant of MODEL_FAMILY_VARIANTS) {
    const results: CallResult[] = [];
    for (let index = 0; index < iterations; index++) {
      try {
        results.push(await callOnce(accessToken, variant));
      } catch (error) {
        results.push({
          status: 0,
          passed: false,
          bodyPreview: `network error: ${(error as Error).message}`,
        });
      }
    }
    const summary = summarize(variant, results);
    writeLine(formatSummaryLine(summary));
    summaries.push(summary);
  }
  return summaries;
}

export async function main(): Promise<void> {
  const iterations = Number.parseInt(process.argv[2] ?? "10", 10);
  if (!Number.isFinite(iterations) || iterations <= 0) {
    throw new Error(
      `Invalid iterations argument: ${JSON.stringify(process.argv[2])}. Pass a positive integer.`
    );
  }

  console.log(
    `Running ${iterations} iteration(s) per variant against ${V2_URL}\n`
  );
  const summaries = await runRepro(iterations);

  const mixed = summaries.filter(
    (summary) => summary.passed > 0 && summary.failed > 0
  );
  console.log("");
  if (mixed.length > 0) {
    console.log(
      "Non-deterministic variants in this session (both passed and failed):"
    );
    for (const summary of mixed) {
      console.log(`  - ${JSON.stringify(summary.variant)}`);
    }
  } else {
    console.log("Every variant was deterministic in this session.");
  }
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  loadEnv({ path: ROOT_ENV });
  main().catch((error) => {
    console.error("Error running model_family repro:", error);
    process.exitCode = 1;
  });
}
