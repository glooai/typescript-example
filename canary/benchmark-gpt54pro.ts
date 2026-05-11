/**
 * benchmark-gpt54pro.ts
 *
 * Three-way latency comparison:
 *   A) Gloo AI       → gloo-openai-gpt-5.4-pro  (Gloo V2 API, routes via OpenRouter internally)
 *   B) OpenRouter    → openai/gpt-5.4-pro        (OpenRouter directly, same underlying model)
 *   C) OpenAI Direct → gpt-4.1                   (OpenAI API directly, different model, baseline)
 *
 * Causal comparison: A vs B only (same underlying model — gpt-5.4-pro via OpenRouter).
 *   If A ≈ B  → Gloo's proxy layer adds minimal overhead; bottleneck is OpenRouter or the model itself.
 *   If A >> B → Gloo's own pipeline (moderation, middleware, etc.) is the bottleneck.
 *
 * C) OpenAI Direct (gpt-4.1) is a non-causal reference only — it uses a different model and
 * cannot be used to attribute latency to OpenRouter or Gloo.
 *
 * Samples are interleaved round-by-round (A→B→C per round) to prevent time-order bias
 * from skewing the A vs B comparison. All requests (including failures) are included in
 * latency stats; the diagnosis is withheld when failure profiles diverge materially.
 *
 * Usage:
 *   pnpm exec tsx canary/benchmark-gpt54pro.ts
 *
 * Reads credentials from canary/.env.benchmark (gitignored).
 * Prints per-endpoint stats and a three-way comparison table:
 * min / p50 / p90 / p95 / p99 / max / failure rate.
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getAccessToken } from "@glooai/scripts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env.benchmark") });

const SAMPLES = 10;
const TIMEOUT_MS = 130_000; // 130s — generous enough to catch the 120s hang
const MAX_TOKENS = 64;

const PROMPT =
  "List three best practices for writing maintainable TypeScript. Be concise.";

const GLOO_URL = "https://platform.ai.gloo.com/ai/v2/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const GLOO_MODEL = "gloo-openai-gpt-5.4-pro"; // Gloo alias → OpenRouter → OpenAI
const OPENROUTER_MODEL = "openai/gpt-5.4-pro"; // OpenRouter directly → OpenAI
const OPENAI_MODEL = "gpt-4.1"; // Non-causal reference only — different model than gpt-5.4-pro

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SampleResult = {
  durationMs: number;
  status: number | null;
  ok: boolean;
  error?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

async function timedFetch(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<SampleResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    return {
      durationMs: Date.now() - started,
      status: res.status,
      ok: res.ok,
      error: res.ok ? undefined : text.slice(0, 300),
    };
  } catch (err) {
    return {
      durationMs: Date.now() - started,
      status: null,
      ok: false,
      error: (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Per-endpoint samplers
// ---------------------------------------------------------------------------

async function sampleGloo(accessToken: string): Promise<SampleResult> {
  return timedFetch(
    GLOO_URL,
    { Authorization: `Bearer ${accessToken}` },
    {
      messages: [{ role: "user", content: PROMPT }],
      model: GLOO_MODEL,
      auto_routing: false,
      max_tokens: MAX_TOKENS,
    }
  );
}

async function sampleOpenRouter(apiKey: string): Promise<SampleResult> {
  return timedFetch(
    OPENROUTER_URL,
    {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://servant.io",
      "X-Title": "Gloo Latency Benchmark",
    },
    {
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: PROMPT }],
      max_tokens: MAX_TOKENS,
    }
  );
}

async function sampleOpenAI(apiKey: string): Promise<SampleResult> {
  return timedFetch(
    OPENAI_URL,
    { Authorization: `Bearer ${apiKey}` },
    {
      model: OPENAI_MODEL,
      messages: [{ role: "user", content: PROMPT }],
      max_tokens: MAX_TOKENS,
    }
  );
}

// ---------------------------------------------------------------------------
// Interleaved sampling — one round per endpoint before advancing to next round
// Prevents time-order bias from skewing provider comparisons.
// ---------------------------------------------------------------------------

type Sampler = { label: string; fn: () => Promise<SampleResult> };

async function runInterleavedSamples(
  samplers: Sampler[]
): Promise<SampleResult[][]> {
  console.log(
    `\nRunning ${SAMPLES} interleaved rounds (${samplers.length} endpoints per round)...`
  );
  const results: SampleResult[][] = samplers.map(() => []);

  for (let round = 0; round < SAMPLES; round++) {
    console.log(`\n  Round ${round + 1}/${SAMPLES}:`);
    for (let j = 0; j < samplers.length; j++) {
      const { label, fn } = samplers[j];
      process.stdout.write(`    ${label}: `);
      const r = await fn();
      const icon = r.ok ? "✓" : "✗";
      process.stdout.write(
        `${icon} ${fmtMs(r.durationMs)} (HTTP ${r.status ?? "timeout"})\n`
      );
      if (!r.ok && r.error) {
        process.stdout.write(`         ${r.error.slice(0, 100)}\n`);
      }
      results[j].push(r);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Stats printer
// ---------------------------------------------------------------------------

function printStats(label: string, results: SampleResult[]): void {
  const all = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const ok = results
    .filter((r) => r.ok)
    .map((r) => r.durationMs)
    .sort((a, b) => a - b);

  console.log(`\n${"─".repeat(62)}`);
  console.log(`  ${label}`);
  console.log(`${"─".repeat(62)}`);
  console.log(
    `  Samples: ${results.length}  |  Success: ${ok.length}  |  Failed: ${results.length - ok.length}`
  );
  console.log(``);

  const rows = [50, 90, 95, 99] as const;
  console.log(
    `  ${pad("Metric", 8)}  ${pad("All requests", 14)}  ${pad("Successful only", 14)}`
  );
  console.log(`  ${"─".repeat(46)}`);
  console.log(
    `  ${pad("min", 8)}  ${pad(fmtMs(all[0] ?? 0), 14)}  ${pad(fmtMs(ok[0] ?? 0), 14)}`
  );
  for (const p of rows) {
    console.log(
      `  ${pad(`p${p}`, 8)}  ${pad(fmtMs(percentile(all, p)), 14)}  ${pad(fmtMs(percentile(ok, p)), 14)}`
    );
  }
  console.log(
    `  ${pad("max", 8)}  ${pad(fmtMs(all[all.length - 1] ?? 0), 14)}  ${pad(fmtMs(ok[ok.length - 1] ?? 0), 14)}`
  );

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of failures) {
      console.log(
        `    [${f.status ?? "timeout"}] ${fmtMs(f.durationMs)}  ${(f.error ?? "").slice(0, 100)}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Three-way comparison table
// ---------------------------------------------------------------------------

function printComparison(
  glooResults: SampleResult[],
  orResults: SampleResult[],
  oaiResults: SampleResult[]
): void {
  // Use ALL durations (including failures) so timeout-heavy paths aren't
  // understated by filtering them out of the percentile calculation.
  const allDurations = (rs: SampleResult[]) =>
    rs.map((r) => r.durationMs).sort((a, b) => a - b);

  const glooDur = allDurations(glooResults);
  const orDur = allDurations(orResults);
  const oaiDur = allDurations(oaiResults);

  const failRate = (rs: SampleResult[]) =>
    rs.length > 0
      ? `${((rs.filter((r) => !r.ok).length / rs.length) * 100).toFixed(0)}%`
      : "n/a";

  console.log(`\n${"═".repeat(72)}`);
  console.log(`  THREE-WAY COMPARISON (all requests, including failures)`);
  console.log(
    `  Causal comparison: A vs B only (same model). C = non-causal reference.`
  );
  console.log(`${"═".repeat(72)}`);
  console.log(
    `  ${pad("Metric", 6)}  ${pad("Gloo AI", 14)}  ${pad("OpenRouter Direct", 20)}  ${pad("OpenAI Direct *ref*", 14)}`
  );
  console.log(
    `           ${pad("(gloo-gpt-5.4-pro)", 14)}  ${pad("(openai/gpt-5.4-pro)", 20)}  ${pad("(gpt-4.1)", 14)}`
  );
  console.log(`  ${"─".repeat(66)}`);

  for (const p of [50, 90, 95, 99] as const) {
    const g = glooDur.length > 0 ? percentile(glooDur, p) : null;
    const o = orDur.length > 0 ? percentile(orDur, p) : null;
    const a = oaiDur.length > 0 ? percentile(oaiDur, p) : null;

    console.log(
      `  ${pad(`p${p}`, 6)}  ${pad(g !== null ? fmtMs(g) : "n/a", 14)}  ${pad(o !== null ? fmtMs(o) : "n/a", 20)}  ${pad(a !== null ? fmtMs(a) : "n/a", 14)}`
    );
  }

  // Failure rate row
  console.log(`  ${"─".repeat(66)}`);
  console.log(
    `  ${pad("fail%", 6)}  ${pad(failRate(glooResults), 14)}  ${pad(failRate(orResults), 20)}  ${pad(failRate(oaiResults), 14)}`
  );

  // ---------------------------------------------------------------------------
  // Overhead analysis — A vs B only (same underlying model, causal comparison)
  // ---------------------------------------------------------------------------
  if (glooDur.length > 0 && orDur.length > 0) {
    const glooP50 = percentile(glooDur, 50);
    const orP50 = percentile(orDur, 50);
    const glooOverOR = glooP50 - orP50;

    console.log(
      `\n  OVERHEAD ANALYSIS — Gloo AI vs OpenRouter (p50, all requests):`
    );
    console.log(
      `    Gloo vs OpenRouter direct : ${glooOverOR >= 0 ? "+" : ""}${fmtMs(glooOverOR)} (${glooOverOR >= 0 ? "+" : ""}${((glooOverOR / Math.max(orP50, 1)) * 100).toFixed(0)}%)`
    );

    // Check whether failure profiles differ materially (>10% absolute gap).
    // When they do, latency percentiles are not directly comparable and a causal
    // conclusion would be misleading.
    const glooFailCount = glooResults.filter((r) => !r.ok).length;
    const orFailCount = orResults.filter((r) => !r.ok).length;
    const failDiffPct = (Math.abs(glooFailCount - orFailCount) / SAMPLES) * 100;

    console.log(`\n  DIAGNOSIS (A vs B):`);
    if (failDiffPct > 10) {
      console.log(
        `    WARNING: failure rates differ materially between providers`
      );
      console.log(
        `    (Gloo: ${glooFailCount}/${SAMPLES} failed, OpenRouter: ${orFailCount}/${SAMPLES} failed).`
      );
      console.log(
        `    Latency percentiles are not directly comparable when failure profiles`
      );
      console.log(
        `    diverge this much — causal conclusion withheld. Investigate failures first.`
      );
    } else {
      const glooVsOrRatio = Math.abs(glooOverOR) / Math.max(orP50, 1);
      if (glooVsOrRatio < 0.15) {
        console.log(
          `    Gloo overhead vs OpenRouter is small (<15%) → Gloo's proxy layer is NOT the primary bottleneck.`
        );
        console.log(
          `    OpenRouter or the underlying model is the likely root cause of end-to-end latency.`
        );
      } else if (glooOverOR > 0) {
        console.log(
          `    Gloo adds significant overhead on top of OpenRouter (+${fmtMs(glooOverOR)}).`
        );
        console.log(
          `    Likely candidates: output moderation (second LLM call), Gloo middleware latency, or LangSmith buffering.`
        );
      } else {
        console.log(
          `    Gloo is actually faster than OpenRouter direct at p50 — unexpected.`
        );
      }
    }

    console.log(``);
    console.log(
      `    * OpenAI Direct (gpt-4.1) is a non-causal reference — it uses a different`
    );
    console.log(
      `      model and cannot be used to attribute latency to OpenRouter or Gloo.`
    );
  }

  console.log(`\n${"═".repeat(72)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const clientId = process.env.GLOO_AI_CLIENT_ID;
  const clientSecret = process.env.GLOO_AI_CLIENT_SECRET;
  const openAiKey = process.env.OPENAI_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;

  if (!clientId || !clientSecret)
    throw new Error("Missing GLOO_AI_CLIENT_ID or GLOO_AI_CLIENT_SECRET");
  if (!openAiKey) throw new Error("Missing OPENAI_API_KEY");
  if (!openRouterKey) throw new Error("Missing OPENROUTER_API_KEY");

  console.log(`\nGPT-5.4 Pro — Three-Way Latency Benchmark`);
  console.log(`${"─".repeat(62)}`);
  console.log(`  A) Gloo AI       : ${GLOO_MODEL}`);
  console.log(`  B) OpenRouter    : ${OPENROUTER_MODEL}`);
  console.log(
    `  C) OpenAI Direct : ${OPENAI_MODEL} (non-causal reference — different model)`
  );
  console.log(`  Samples          : ${SAMPLES} interleaved rounds`);
  console.log(`  Timeout          : ${TIMEOUT_MS / 1000}s per request`);
  console.log(`  Prompt           : "${PROMPT}"`);

  console.log(`\nFetching Gloo access token...`);
  const tokenResponse = await getAccessToken({ clientId, clientSecret });
  const accessToken = tokenResponse.access_token;
  if (!accessToken) throw new Error("No access_token in Gloo token response");
  console.log(`  OK`);

  const [glooResults, orResults, oaiResults] = await runInterleavedSamples([
    { label: "A) Gloo AI      ", fn: () => sampleGloo(accessToken) },
    { label: "B) OpenRouter   ", fn: () => sampleOpenRouter(openRouterKey) },
    { label: "C) OpenAI Direct", fn: () => sampleOpenAI(openAiKey) },
  ]);

  printStats(`A) Gloo AI — ${GLOO_MODEL}`, glooResults);
  printStats(`B) OpenRouter Direct — ${OPENROUTER_MODEL}`, orResults);
  printStats(
    `C) OpenAI Direct — ${OPENAI_MODEL} (non-causal reference)`,
    oaiResults
  );
  printComparison(glooResults, orResults, oaiResults);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
