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
  | "REFUSAL_REGRESSION"
  /**
   * Platform returned HTTP 403 for a model that our creds aren't
   * entitled to. Stable configuration/entitlement signal, not an
   * outage — always mapped to YELLOW so it flows into the digest
   * thread instead of the RED alert path. (Common cause: a model
   * published to `/platform/v2/models` that our canary OAuth client
   * hasn't been granted access to.)
   */
  | "NOT_ENTITLED"
  /**
   * Probe-side `AbortSignal.timeout()` fired before the upstream
   * responded. Always mapped to YELLOW — the canary's own timeout
   * elapsing doesn't prove the platform is down, only that the model
   * was slower than our per-fixture budget. Persistent TIMEOUT
   * entries in the daily digest are the signal to either raise the
   * fixture budget or escalate upstream.
   */
  | "TIMEOUT"
  /**
   * Tool-calling probe expected `finish_reason="tool_calls"` and a
   * matching function invocation, but the model responded with plain
   * text instead. Indicates the tool-call routing layer or model
   * capability has regressed — always RED.
   */
  | "TOOL_CALL_MISSING"
  /**
   * Safety probe sent a known-harmful jailbreak prompt and expected
   * the guardrail to refuse it, but the model produced a helpful
   * response. Indicates the safety layer has been bypassed — always RED.
   */
  | "GUARDRAIL_BYPASS"
  /**
   * `expectRejection` probe (image-only model/family) was NOT rejected:
   * the platform returned a 2xx for a model that has no text output and
   * should have been refused on the Chat Completions surface. Indicates
   * the ai-api GAI-6788 guard regressed (the request is being routed and
   * the image model processed into an empty completion) - always RED.
   */
  | "UNEXPECTED_SUCCESS"
  /**
   * Ingestion probe: the submitted item did not reach a terminal
   * status within the fixture's SLA budget - the pipeline is stalled
   * (stuck in QUEUED/CHUNKING/...). This is the primary "customers'
   * ingestion is silently hanging" signal - always RED. Distinct from
   * TIMEOUT (a single HTTP request outliving its budget, YELLOW):
   * SLA_EXCEEDED means the platform accepted the work and then never
   * finished it.
   */
  | "SLA_EXCEEDED"
  /**
   * Ingestion probe: the pipeline worked end to end (submit ->
   * COMPLETED -> retrievable) but the best-effort hard-delete of the
   * canary item failed, leaking a test document into the canary
   * publisher. Not an outage - YELLOW, so it lands in the digest
   * thread as a "go clean this up" signal.
   */
  | "CLEANUP_FAILED";

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
