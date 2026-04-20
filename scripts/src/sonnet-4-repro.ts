/**
 * Reduced repro: Sonnet 4 on V1 Messages vs. V2 Completions
 *
 * Exercises three side-by-side calls against the Gloo AI platform to compare
 * the legacy V1 Messages endpoint (with the Anthropic Bedrock inference
 * profile `us.anthropic.claude-sonnet-4-20250514-v1:0`) against V2 Completions
 * with the currently-supported Gloo aliases `gloo-anthropic-claude-sonnet-4.5`
 * and `gloo-anthropic-claude-haiku-4.5`.
 *
 * Observed failure signatures on V1 with the deprecated model ID:
 *   - HTTP 5xx with `{"detail":"Error generating response."}`
 *   - HTTP 200 with `choices[0].message.content === ""` (empty completion)
 *
 * The verdict classifier below distinguishes both cases so the script is a
 * stable regression check across routing paths.
 *
 * Anthropic lifecycle context (publicly announced 2026-04-14):
 *   - `claude-sonnet-4-20250514`: Deprecated 2026-04-14, retires 2026-06-15.
 *   - API users may experience degraded availability starting 2026-05-14.
 *   - Recommended replacements remain available on Gloo V2: Sonnet 4.5 and
 *     Haiku 4.5 (Active; not sooner than 2026-09-29 / 2026-10-15).
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import {
  loadCredentials,
  getAccessToken,
  withTimeout,
  type Credentials,
} from "./auth.js";

const V1_URL = "https://platform.ai.gloo.com/ai/v1/chat/completions";
const V2_URL = "https://platform.ai.gloo.com/ai/v2/chat/completions";

/** Deprecated Anthropic Bedrock inference profile under test on V1. */
export const FAILING_V1_MODEL = "us.anthropic.claude-sonnet-4-20250514-v1:0";

/** Supported V2 alias for the Sonnet 4.5 family. */
export const RECOMMENDED_V2_SONNET_MODEL = "gloo-anthropic-claude-sonnet-4.5";

/** Supported V2 alias for the Haiku 4.5 family — a faster, cheaper drop-in. */
export const RECOMMENDED_V2_HAIKU_MODEL = "gloo-anthropic-claude-haiku-4.5";

export const REPRO_PROMPT =
  "In one sentence, name three best practices for clear technical writing.";

export type ReproCase = {
  label: string;
  endpoint: string;
  apiVersion: "v1" | "v2";
  model: string;
  body: Record<string, unknown>;
};

export type ReproOutcome = {
  label: string;
  endpoint: string;
  model: string;
  status: number;
  ok: boolean;
  /** Populated when the platform returned HTTP 2xx but the choice was empty. */
  emptyCompletion: boolean;
  /** First ~400 chars of response body for inspection. */
  responsePreview: string;
  contentPreview: string | null;
  durationMs: number;
  verdict: "PASS" | "FAIL" | "EMPTY_COMPLETION";
};

type ChatLikeResponse = {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
};

export function buildCases(prompt: string = REPRO_PROMPT): ReproCase[] {
  const messages = [
    {
      role: "system" as const,
      content: "You are a concise assistant.",
    },
    { role: "user" as const, content: prompt },
  ];

  return [
    {
      label: "V1 Messages + deprecated Sonnet 4",
      endpoint: V1_URL,
      apiVersion: "v1",
      model: FAILING_V1_MODEL,
      body: { model: FAILING_V1_MODEL, messages },
    },
    {
      label: "V2 Completions + Sonnet 4.5",
      endpoint: V2_URL,
      apiVersion: "v2",
      model: RECOMMENDED_V2_SONNET_MODEL,
      body: {
        model: RECOMMENDED_V2_SONNET_MODEL,
        messages,
        auto_routing: false,
      },
    },
    {
      label: "V2 Completions + Haiku 4.5 (drop-in for Sonnet 4)",
      endpoint: V2_URL,
      apiVersion: "v2",
      model: RECOMMENDED_V2_HAIKU_MODEL,
      body: {
        model: RECOMMENDED_V2_HAIKU_MODEL,
        messages,
        auto_routing: false,
      },
    },
  ];
}

export function extractContent(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as ChatLikeResponse;
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === "string" && content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export function verdictFor(
  status: number,
  rawBody: string
): { verdict: ReproOutcome["verdict"]; emptyCompletion: boolean } {
  if (status < 200 || status >= 300) {
    return { verdict: "FAIL", emptyCompletion: false };
  }
  const content = extractContent(rawBody);
  if (content === null) {
    return { verdict: "EMPTY_COMPLETION", emptyCompletion: true };
  }
  return { verdict: "PASS", emptyCompletion: false };
}

export async function runCase(
  accessToken: string,
  testCase: ReproCase,
  timeoutMs = 30_000
): Promise<ReproOutcome> {
  const { controller, clearTimer } = withTimeout(timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(testCase.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(testCase.body),
      signal: controller.signal,
    });

    const rawBody = await response.text();
    const { verdict, emptyCompletion } = verdictFor(response.status, rawBody);
    const contentPreview = extractContent(rawBody);

    return {
      label: testCase.label,
      endpoint: testCase.endpoint,
      model: testCase.model,
      status: response.status,
      ok: response.ok,
      emptyCompletion,
      responsePreview: rawBody.slice(0, 400),
      contentPreview: contentPreview ? contentPreview.slice(0, 200) : null,
      durationMs: Date.now() - start,
      verdict,
    };
  } finally {
    clearTimer();
  }
}

export async function runAllCases(
  credentials: Credentials,
  prompt: string = REPRO_PROMPT
): Promise<ReproOutcome[]> {
  const tokenResponse = await getAccessToken(credentials);
  const accessToken = tokenResponse.access_token;
  if (!accessToken) {
    throw new Error("Access token missing from token response.");
  }

  const cases = buildCases(prompt);
  const outcomes: ReproOutcome[] = [];
  for (const testCase of cases) {
    outcomes.push(await runCase(accessToken, testCase));
  }
  return outcomes;
}

function formatOutcome(outcome: ReproOutcome): string {
  const lines = [
    `─── ${outcome.label}`,
    `    endpoint : ${outcome.endpoint}`,
    `    model    : ${outcome.model}`,
    `    status   : HTTP ${outcome.status} (${outcome.durationMs}ms)`,
    `    verdict  : ${outcome.verdict}`,
  ];
  if (outcome.contentPreview) {
    lines.push(`    content  : ${outcome.contentPreview}`);
  } else {
    lines.push(`    body     : ${outcome.responsePreview}`);
  }
  return lines.join("\n");
}

export async function main(): Promise<void> {
  const credentials = loadCredentials();
  const outcomes = await runAllCases(credentials);

  console.log("Sonnet 4 V1→V2 reduced repro");
  console.log("============================");
  for (const outcome of outcomes) {
    console.log(formatOutcome(outcome));
  }

  const v1 = outcomes[0];
  if (v1.verdict === "PASS") {
    console.log(
      "\nNote: V1 call passed in this environment. Failure signatures can vary by tenant/region routing — re-run with different JWT audiences if you are chasing an intermittent."
    );
  }
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  loadEnv({ path: ".env.local" });
  main().catch((error) => {
    console.error("Error running Sonnet 4 repro:", error);
    process.exitCode = 1;
  });
}
