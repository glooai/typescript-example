/**
 * Client-side mirror of the proxy Lambda's response contracts
 * (`demo/api/src/types.ts`). Kept as a separate declaration rather than a
 * workspace import so the SPA stays a pure static bundle with no build-time
 * coupling to the Node package.
 */

export type RoutingMode = "auto_routing" | "model_family" | "model";

export type RoutingSelection = {
  mode: RoutingMode;
  modelFamily?: string;
  model?: string;
  tradition?: string;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type CallMetrics = {
  requestId: string;
  routingMechanism: RoutingMode;
  requested: string;
  resolvedModel: string | null;
  resolvedFamily: string | null;
  routingTier: string | null;
  routingConfidence: number | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  latencyMs: number;
  ttftMs: number | null;
  costUsd: number | null;
  status: "ok" | "error";
  errorMessage?: string;
};

export type CompareResult = CallMetrics & { text: string };

export type LedgerRow = CallMetrics & { timestamp: string };

export type LedgerModelRollup = {
  model: string;
  calls: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  avgCompletionTokens: number;
};

export type ModelSummary = {
  id: string;
  name: string;
  family: string;
  inputRatePerMillion: number | null;
  outputRatePerMillion: number | null;
};
