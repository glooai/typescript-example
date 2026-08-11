/**
 * Thin client for the proxy Lambda. Every call is same-origin (`/api/*` is
 * a CloudFront cache behavior pointing at the Lambda Function URL), so
 * there are no credentials, no CORS, and no API key in this bundle.
 */
import type {
  ChatMessage,
  CallMetrics,
  CompareResult,
  LedgerModelRollup,
  LedgerRow,
  ModelSummary,
  RoutingSelection,
  SessionSummary,
} from "./types";

const SESSION_STORAGE_KEY = "gloo-demo-session-id";

/**
 * Opaque id used only to key this browser's saved transcript in DynamoDB.
 * It grants no access to anything, so localStorage is the right home for
 * it: the point is that it survives a refresh.
 */
export function getSessionId(): string {
  const existing = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) {
    return existing;
  }
  return rememberSessionId(`s-${crypto.randomUUID().replace(/-/g, "")}`);
}

/** Which conversation a refresh will land back in. */
export function rememberSessionId(sessionId: string): string {
  window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  return sessionId;
}

/** A fresh conversation. Nothing server side is created until a first turn. */
export function startSession(): string {
  return rememberSessionId(`s-${crypto.randomUUID().replace(/-/g, "")}`);
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function fetchModels(
  signal?: AbortSignal
): Promise<ModelSummary[]> {
  const response = await fetch("/api/models", { signal });
  const body = await readJson<{ models: ModelSummary[] }>(response);
  return body.models;
}

export async function fetchLedger(
  signal?: AbortSignal
): Promise<{ rows: LedgerRow[]; rollups: LedgerModelRollup[] }> {
  const response = await fetch("/api/ledger", { signal });
  return readJson(response);
}

export async function fetchSession(
  sessionId: string,
  signal?: AbortSignal
): Promise<ChatMessage[]> {
  const response = await fetch(
    `/api/session?id=${encodeURIComponent(sessionId)}`,
    { signal }
  );
  const body = await readJson<{ messages: ChatMessage[] }>(response);
  return body.messages.filter(
    (message) => message.role === "user" || message.role === "assistant"
  );
}

/**
 * This browser's past conversations. The server answers from the anonymous
 * visitor cookie, so a browser that refuses cookies gets an empty list rather
 * than an error, and the caller renders that as "no history yet".
 */
export async function fetchSessions(
  signal?: AbortSignal
): Promise<SessionSummary[]> {
  const response = await fetch("/api/sessions", { signal });
  const body = await readJson<{ sessions: SessionSummary[] }>(response);
  return body.sessions;
}

export async function runComparison(options: {
  sessionId: string;
  prompt: string;
  variants: RoutingSelection[];
  signal?: AbortSignal;
}): Promise<CompareResult[]> {
  const response = await fetch("/api/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: options.sessionId,
      prompt: options.prompt,
      variants: options.variants,
    }),
    signal: options.signal,
  });
  const body = await readJson<{ results: CompareResult[] }>(response);
  return body.results;
}

type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "meta"; metrics: CallMetrics }
  | { type: "error"; message: string };

/**
 * Stream a chat completion. The Lambda re-frames Gloo's OpenAI-shaped SSE
 * into three event types so the client does not have to know the upstream
 * chunk format, and closes with a `meta` frame carrying the measurements
 * that also went into the DynamoDB ledger.
 */
export async function streamChat(options: {
  sessionId: string;
  messages: ChatMessage[];
  routing: RoutingSelection;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onMeta: (metrics: CallMetrics) => void;
}): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: options.sessionId,
      messages: options.messages,
      routing: options.routing,
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Chat failed with ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (payload === "[DONE]" || payload.length === 0) {
        continue;
      }
      let event: ChatEvent;
      try {
        event = JSON.parse(payload) as ChatEvent;
      } catch {
        continue;
      }
      if (event.type === "delta") {
        options.onDelta(event.text);
      } else if (event.type === "meta") {
        options.onMeta(event.metrics);
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }
  }
}
