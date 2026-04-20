/**
 * Probe contract. Every probe — V1 messages, V2 completions, search, items —
 * implements this interface so runners / sinks / state can treat them
 * uniformly.
 */

export type Severity = "RED" | "YELLOW" | "GREEN";

export type Verdict =
  | "PASS"
  | "FAIL"
  | "EMPTY_COMPLETION"
  | "SCHEMA_MISMATCH"
  | "REFUSAL_REGRESSION";

export type ProbeContext = {
  accessToken: string;
  runId: string;
  startedAt: string;
};

export type ProbeOutcome = {
  /** Stable identifier — used for dedup across runs. e.g. "v2-completions/auto_routing/anthropic" */
  signature: string;
  /** Human label for Slack/stdout. */
  label: string;
  endpoint: string;
  apiVersion: "v1" | "v2" | "search" | "items";
  model?: string;
  httpStatus: number | null;
  verdict: Verdict;
  severity: Severity;
  durationMs: number;
  /** First N chars of response for debugging; keep small so Slack posts don't balloon. */
  responsePreview?: string;
  contentPreview?: string | null;
  /** Extra structured context for the sinks (schema issues, refusal text, etc). */
  details: Record<string, unknown>;
  /** Unix seconds from Date.now() / 1000 — used for latency trending. */
  completedAt: number;
};

export type Probe = {
  signature: string;
  label: string;
  run(ctx: ProbeContext): Promise<ProbeOutcome>;
};
