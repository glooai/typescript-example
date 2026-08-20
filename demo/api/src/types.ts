/**
 * Shared request/response contracts between the static SPA and the proxy
 * API service. The SPA imports nothing from this package at build time (it is a
 * separate workspace with its own copy of the response types), so these are
 * plain structural types with no runtime dependency.
 */

/** The three routing mechanisms Gloo Completions V2 exposes. */
export type RoutingMode = "auto_routing" | "model_family" | "model";

/** One resolved routing selection: exactly one mechanism, fully specified. */
export type RoutingSelection = {
  mode: RoutingMode;
  /** Required when `mode === "model_family"` (openai/anthropic/google/open source). */
  modelFamily?: string;
  /** Required when `mode === "model"` (e.g. `gloo-openai-gpt-5-mini`). */
  model?: string;
  /** Optional theological perspective passed straight through to Gloo. */
  tradition?: string;
};

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

/** `POST /api/chat` request body. */
export type ChatRequest = {
  sessionId: string;
  messages: ChatMessage[];
  routing: RoutingSelection;
};

/** `POST /api/compare` request body. */
export type CompareRequest = {
  sessionId: string;
  prompt: string;
  /** Between 2 and 4 routing selections, run concurrently against one prompt. */
  variants: RoutingSelection[];
};

/**
 * What we measured for one proxied Gloo call. This is the payload of the
 * terminal `gloo-meta` SSE frame on `/api/chat`, one entry of the
 * `/api/compare` response, and the shape persisted to the DynamoDB ledger.
 */
export type CallMetrics = {
  requestId: string;
  routingMechanism: RoutingMode;
  /** What the caller asked for: a family name, a model id, or `auto`. */
  requested: string;
  /** What Gloo actually ran, read off the response `model` field. */
  resolvedModel: string | null;
  resolvedFamily: string | null;
  routingTier: string | null;
  routingConfidence: number | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Wall-clock time from request start to the last byte of the response. */
  latencyMs: number;
  /** Time to first token. Only measured on the streaming chat path. */
  ttftMs: number | null;
  /** Estimated USD, derived from live registry pricing times observed tokens. */
  costUsd: number | null;
  status: "ok" | "error";
  errorMessage?: string;
};

export type CompareResponse = {
  results: Array<CallMetrics & { text: string }>;
};

/** One row of `GET /api/ledger`, plus the per-model rollup that view renders. */
export type LedgerRow = CallMetrics & { timestamp: string };

export type LedgerModelRollup = {
  model: string;
  calls: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  avgCompletionTokens: number;
};

export type LedgerResponse = {
  rows: LedgerRow[];
  rollups: LedgerModelRollup[];
};

/** One entry of `GET /api/sessions`: a past conversation, listed not replayed. */
export type SessionSummary = {
  id: string;
  lastMessageAt: string;
  /** The conversation's opening question, collapsed and truncated. */
  preview: string;
  /** Auto-generated or user-supplied label; null until either has happened. */
  title: string | null;
  pinned: boolean;
  archived: boolean;
};

export type SessionsResponse = {
  sessions: SessionSummary[];
};

/** `PATCH /api/session?id=<id>` request body. Every field is optional. */
export type SessionPatch = {
  pinned?: boolean;
  archived?: boolean;
  /** A rename. Setting this marks the title as the visitor's own, for good. */
  title?: string;
};

/** Trimmed `/platform/v2/models` entry, as re-served by `GET /api/models`. */
export type ModelSummary = {
  id: string;
  name: string;
  family: string;
  inputRatePerMillion: number | null;
  outputRatePerMillion: number | null;
};
