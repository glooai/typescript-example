/**
 * "What's New — Week of May 26, 2026" release validators.
 *
 * Gloo published a platform changelog for the week of 2026-05-26 (11 new
 * models, a Gemini Flash-Lite GA promotion, prompt-cache usage metrics,
 * and clearer provider-validation errors). This script demonstrates and
 * *programmatically validates* the subset of those claims that can be
 * checked automatically from a single OAuth client — without eyeballing a
 * Studio dashboard or reasoning about non-deterministic behavior.
 *
 * Three checks, each backed by a pure, unit-tested classifier:
 *
 *   1. New-model availability — validated against the authoritative
 *      `/platform/v2/models` registry (the same source of truth the canary
 *      hydrates from). We assert by *display name*, not by guessing alias
 *      IDs, so the check can't drift on a naming convention we don't control.
 *
 *   2. Prompt-cache usage metrics — the changelog promises new
 *      `cache_tokens` and `cache_hit_rate` fields in the usage API. We send
 *      a completion and validate those fields are present and well-formed.
 *
 *   3. Provider-validation error clarity — the changelog promises provider
 *      validation errors now surface as actionable 4xx client errors instead
 *      of generic 500s. We send a deliberately invalid model and classify the
 *      response shape.
 *
 * What this script deliberately does NOT try to validate (not cheaply
 * automatable from here) is enumerated in the PR description: Studio billing
 * /usage UI, streaming reliability, guardrail tuning, GlooCode, Data Engine
 * org caps, and docs restructuring.
 *
 * Everything network-touching is gated behind the entrypoint check at the
 * bottom; the exported functions are pure (or take an injectable `fetchImpl`)
 * so the whole module is testable without hitting the platform.
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import {
  loadCredentials,
  getAccessToken,
  withTimeout,
  type Credentials,
} from "./auth.js";

export const MODELS_REGISTRY_URL =
  "https://platform.ai.gloo.com/platform/v2/models";
export const COMPLETIONS_V2_URL =
  "https://platform.ai.gloo.com/ai/v2/chat/completions";

// ---------------------------------------------------------------------------
// Capability 1 — new-model availability (validated against the live registry)
// ---------------------------------------------------------------------------

/** Subset of a `/platform/v2/models` entry we consume. */
export type RegistryModel = {
  id: string;
  name: string;
  family: string;
};

/**
 * One claim from the changelog's model list. We match on lowercased
 * substrings of the registry `name` (which mirrors the Studio Model Explorer
 * display name) rather than guessing the `gloo-<provider>-<model>` alias, so
 * a check stays valid even if the alias scheme differs from our guess.
 *
 * `nameIncludes` — ALL substrings must be present (AND).
 * `nameExcludes` — NONE may be present (used to assert a GA, i.e. "not preview").
 */
export type ModelExpectation = {
  label: string;
  nameIncludes: string[];
  nameExcludes?: string[];
};

/**
 * The 11 new models from the 2026-05-26 changelog, plus the Gemini 3.1
 * Flash Lite GA promotion (asserted as present-and-not-"preview").
 *
 * NOTE: the changelog groups "Qwen 3 235B A22B variants" and the two MiMo
 * models loosely; the named entries below are the ones with an unambiguous
 * display name to match on. ABSENT does not necessarily mean "not launched"
 * — it can also mean this OAuth client/tenant/region isn't entitled to it
 * yet (cf. the canary's NOT_ENTITLED signal). The check surfaces the gap; a
 * human confirms the cause.
 */
export const EXPECTED_NEW_MODELS: ModelExpectation[] = [
  { label: "Claude Opus 4.8", nameIncludes: ["opus", "4.8"] },
  { label: "GPT-5.3 Codex", nameIncludes: ["5.3", "codex"] },
  { label: "Claude Opus 4.7 Fast", nameIncludes: ["opus", "4.7", "fast"] },
  { label: "Claude Opus 4.6 Fast", nameIncludes: ["opus", "4.6", "fast"] },
  { label: "Qwen 3.5 Plus", nameIncludes: ["qwen", "3.5", "plus"] },
  { label: "Qwen 3.5 27B", nameIncludes: ["qwen", "3.5", "27b"] },
  { label: "Qwen 3 235B A22B", nameIncludes: ["qwen", "235b", "a22b"] },
  { label: "GLM-4.7 Flash", nameIncludes: ["glm", "4.7", "flash"] },
  { label: "MiMo V2 Flash", nameIncludes: ["mimo", "v2", "flash"] },
  { label: "MiMo V2.5", nameIncludes: ["mimo", "v2.5"] },
];

/** The preview→GA promotion is a distinct claim from the 11 new models. */
export const EXPECTED_GA_PROMOTION: ModelExpectation = {
  label: "Gemini 3.1 Flash Lite (preview → GA)",
  nameIncludes: ["gemini", "3.1", "flash", "lite"],
  nameExcludes: ["preview"],
};

export type ModelAvailability = {
  label: string;
  status: "PRESENT" | "ABSENT";
  matchedId: string | null;
  matchedName: string | null;
};

/** Pure: does this registry entry satisfy the expectation? */
export function matchesExpectation(
  model: RegistryModel,
  expectation: ModelExpectation
): boolean {
  const name = model.name.toLowerCase();
  const hasAll = expectation.nameIncludes.every((needle) =>
    name.includes(needle.toLowerCase())
  );
  if (!hasAll) return false;
  const hasForbidden = (expectation.nameExcludes ?? []).some((needle) =>
    name.includes(needle.toLowerCase())
  );
  return !hasForbidden;
}

/** Pure: find the first registry entry matching an expectation. */
export function findModel(
  registry: RegistryModel[],
  expectation: ModelExpectation
): RegistryModel | null {
  return registry.find((m) => matchesExpectation(m, expectation)) ?? null;
}

/** Pure: assess every expectation against a registry snapshot. */
export function assessModelAvailability(
  registry: RegistryModel[],
  expectations: ModelExpectation[]
): ModelAvailability[] {
  return expectations.map((expectation) => {
    const match = findModel(registry, expectation);
    return {
      label: expectation.label,
      status: match ? "PRESENT" : "ABSENT",
      matchedId: match?.id ?? null,
      matchedName: match?.name ?? null,
    };
  });
}

type RegistryResponse = { data?: unknown };

/** Pure: narrow an arbitrary parsed body into RegistryModel[]. */
export function parseRegistry(raw: unknown): RegistryModel[] {
  const data = (raw as RegistryResponse | null)?.data;
  if (!Array.isArray(data)) {
    throw new Error("registry response missing a `data` array");
  }
  return data.flatMap((entry): RegistryModel[] => {
    if (entry === null || typeof entry !== "object") return [];
    const { id, name, family } = entry as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      typeof family !== "string"
    ) {
      return [];
    }
    return [{ id, name, family }];
  });
}

/** Network: fetch + parse the authoritative V2 model registry. */
export async function fetchModelRegistry(
  timeoutMs = 10_000
): Promise<RegistryModel[]> {
  const { controller, clearTimer } = withTimeout(timeoutMs);
  try {
    const response = await fetch(MODELS_REGISTRY_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `GET ${MODELS_REGISTRY_URL} failed with status ${response.status}: ${body.slice(0, 300)}`
      );
    }
    return parseRegistry(await response.json());
  } finally {
    clearTimer();
  }
}

// ---------------------------------------------------------------------------
// Capability 2 — prompt-cache usage metrics
// ---------------------------------------------------------------------------

export type CacheUsageSummary = {
  status: "METRICS_PRESENT" | "METRICS_MISSING";
  cacheTokens: number | null;
  cacheHitRate: number | null;
  notes: string[];
};

/**
 * Pure: validate the new `cache_tokens` / `cache_hit_rate` usage fields.
 *
 * The changelog promises both fields in the usage API. We confirm they are
 * present and well-formed (cache_tokens a non-negative integer; cache_hit_rate
 * a ratio in [0, 1]). Missing or malformed fields → METRICS_MISSING.
 */
export function summarizeCacheUsage(usage: unknown): CacheUsageSummary {
  const notes: string[] = [];
  const u = (usage ?? {}) as Record<string, unknown>;
  const rawTokens = u.cache_tokens;
  const rawRate = u.cache_hit_rate;

  let cacheTokens: number | null = null;
  if (typeof rawTokens === "number" && Number.isFinite(rawTokens)) {
    if (rawTokens >= 0) cacheTokens = rawTokens;
    else notes.push("cache_tokens is negative");
  } else if (rawTokens !== undefined) {
    notes.push("cache_tokens present but not a number");
  } else {
    notes.push("cache_tokens absent");
  }

  let cacheHitRate: number | null = null;
  if (typeof rawRate === "number" && Number.isFinite(rawRate)) {
    if (rawRate >= 0 && rawRate <= 1) cacheHitRate = rawRate;
    else notes.push("cache_hit_rate outside [0, 1]");
  } else if (rawRate !== undefined) {
    notes.push("cache_hit_rate present but not a number");
  } else {
    notes.push("cache_hit_rate absent");
  }

  const status =
    cacheTokens !== null && cacheHitRate !== null
      ? "METRICS_PRESENT"
      : "METRICS_MISSING";
  return { status, cacheTokens, cacheHitRate, notes };
}

// ---------------------------------------------------------------------------
// Capability 3 — provider-validation error clarity
// ---------------------------------------------------------------------------

export type ErrorClassification =
  | "OK"
  | "ACTIONABLE_CLIENT_ERROR"
  | "OPAQUE_CLIENT_ERROR"
  | "GENERIC_SERVER_ERROR";

/** Pure: pull a human-readable message out of an error body, if any. */
export function extractErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ["detail", "message", "error"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
      if (value && typeof value === "object") {
        const nested = (value as Record<string, unknown>).message;
        if (typeof nested === "string" && nested.trim().length > 0)
          return nested;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure: classify a response to a deliberately-invalid request.
 *
 * The changelog's promise is "actionable client errors instead of generic
 * 500s." So a 4xx carrying a structured message is the *good* new behavior;
 * a 5xx is the *old* behavior we're checking is gone.
 */
export function classifyErrorResponse(
  status: number,
  body: string
): { classification: ErrorClassification; message: string | null } {
  const message = extractErrorMessage(body);
  if (status >= 200 && status < 300) {
    return { classification: "OK", message };
  }
  if (status >= 500) {
    return { classification: "GENERIC_SERVER_ERROR", message };
  }
  if (status >= 400) {
    return {
      classification: message
        ? "ACTIONABLE_CLIENT_ERROR"
        : "OPAQUE_CLIENT_ERROR",
      message,
    };
  }
  return { classification: "GENERIC_SERVER_ERROR", message };
}

// ---------------------------------------------------------------------------
// Live runners (network) — thin wrappers over the pure classifiers above
// ---------------------------------------------------------------------------

export const CACHE_PROBE_MODEL = "gloo-anthropic-claude-haiku-4.5";
/** An intentionally invalid alias to trigger provider validation. */
export const INVALID_PROBE_MODEL = "gloo-nonexistent-model-zzz";

async function postCompletion(
  accessToken: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<{ status: number; raw: string }> {
  const { controller, clearTimer } = withTimeout(timeoutMs);
  try {
    const response = await fetch(COMPLETIONS_V2_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: response.status, raw: await response.text() };
  } finally {
    clearTimer();
  }
}

export async function checkModelAvailability(): Promise<ModelAvailability[]> {
  const registry = await fetchModelRegistry();
  return [
    ...assessModelAvailability(registry, EXPECTED_NEW_MODELS),
    ...assessModelAvailability(registry, [EXPECTED_GA_PROMOTION]),
  ];
}

export async function checkPromptCache(
  accessToken: string
): Promise<CacheUsageSummary> {
  const { raw } = await postCompletion(accessToken, {
    model: CACHE_PROBE_MODEL,
    auto_routing: false,
    messages: [
      { role: "user", content: "Reply with the single word: cached." },
    ],
    max_tokens: 16,
  });
  let usage: unknown = undefined;
  try {
    usage = (JSON.parse(raw) as Record<string, unknown>).usage;
  } catch {
    usage = undefined;
  }
  return summarizeCacheUsage(usage);
}

export async function checkErrorClarity(accessToken: string): Promise<{
  status: number;
  classification: ErrorClassification;
  message: string | null;
}> {
  const { status, raw } = await postCompletion(accessToken, {
    model: INVALID_PROBE_MODEL,
    auto_routing: false,
    messages: [{ role: "user", content: "hi" }],
  });
  return { status, ...classifyErrorResponse(status, raw) };
}

export type WhatsNewReport = {
  models: ModelAvailability[];
  cache: CacheUsageSummary;
  errorClarity: {
    status: number;
    classification: ErrorClassification;
    message: string | null;
  };
};

export async function runWhatsNewChecks(
  credentials: Credentials
): Promise<WhatsNewReport> {
  const tokenResponse = await getAccessToken(credentials);
  const accessToken = tokenResponse.access_token;
  if (!accessToken) {
    throw new Error("Access token missing from token response.");
  }
  // Model registry is unauthenticated, but we fetch it inside the same run
  // so the report is a single coherent snapshot.
  const [models, cache, errorClarity] = [
    await checkModelAvailability(),
    await checkPromptCache(accessToken),
    await checkErrorClarity(accessToken),
  ];
  return { models, cache, errorClarity };
}

function formatReport(report: WhatsNewReport): string {
  const lines: string[] = [];
  lines.push("What's New — 2026-05-26 — automated validation");
  lines.push("===============================================");

  lines.push("\n[1] New models (vs. /platform/v2/models registry)");
  for (const m of report.models) {
    const detail = m.matchedName ? ` → ${m.matchedName} (${m.matchedId})` : "";
    lines.push(`    ${m.status === "PRESENT" ? "✓" : "✗"} ${m.label}${detail}`);
  }

  lines.push("\n[2] Prompt-cache usage metrics");
  lines.push(`    status        : ${report.cache.status}`);
  lines.push(`    cache_tokens  : ${report.cache.cacheTokens ?? "—"}`);
  lines.push(`    cache_hit_rate: ${report.cache.cacheHitRate ?? "—"}`);
  if (report.cache.notes.length > 0) {
    lines.push(`    notes         : ${report.cache.notes.join("; ")}`);
  }

  lines.push("\n[3] Provider-validation error clarity (invalid model)");
  lines.push(
    `    HTTP ${report.errorClarity.status} → ${report.errorClarity.classification}`
  );
  if (report.errorClarity.message) {
    lines.push(`    message       : ${report.errorClarity.message}`);
  }

  return lines.join("\n");
}

export async function main(): Promise<void> {
  const credentials = loadCredentials();
  const report = await runWhatsNewChecks(credentials);
  console.log(formatReport(report));

  const absent = report.models.filter((m) => m.status === "ABSENT");
  if (absent.length > 0) {
    console.log(
      `\nNote: ${absent.length} expected model(s) ABSENT from the registry for this client. ` +
        "This can be a not-yet-entitled / region-routing gap rather than an unlaunched model — confirm in the Studio Model Explorer."
    );
  }
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  loadEnv({ path: ".env.local" });
  main().catch((error) => {
    console.error("Error running What's-New validation:", error);
    process.exitCode = 1;
  });
}
