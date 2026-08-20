/**
 * Lambda Function URL handler for the Gloo AI demo.
 *
 * Deployed in RESPONSE_STREAM invoke mode so `/api/chat` can stream tokens
 * to the browser as they arrive. The comparison endpoint is deliberately
 * buffered: it fans one prompt out to several routing modes concurrently
 * and the view only becomes meaningful once every variant has finished, so
 * streaming it would add complexity for no user-visible gain.
 *
 * The frontend is a static SPA on S3/CloudFront and holds no credentials.
 * Every Gloo call goes through here, where the API key is read from Secrets
 * Manager at cold start.
 *
 * This is also where the anonymous visitor cookie is minted and read, since
 * it is the only layer that both has real crypto and writes the rows the id
 * exists to correlate. See `visitor.ts` for that reasoning in full. Nothing
 * on any route depends on the cookie being present.
 */
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { loadConfig, loadGlooApiKey, type Config } from "./config.js";
import {
  createAccumulator,
  createGlooClient,
  toMetrics,
  type GlooClient,
} from "./gloo.js";
import { rollupByModel } from "./ledger.js";
import { createRegistryLoader } from "./pricing.js";
import { chatRequestSchema, compareRequestSchema } from "./routing.js";
import { createStore, type Store } from "./store.js";
import type {
  CallMetrics,
  ChatMessage,
  ModelSummary,
  RoutingSelection,
} from "./types.js";
import type { ResponseStream } from "./awslambda.js";
import {
  resolveVisitor,
  toVisitorTrace,
  visitorHeaders,
  type VisitorContext,
} from "./visitor.js";

const LEDGER_PAGE_SIZE = 40;

const loadRegistry = createRegistryLoader();

let config: Config | null = null;
let store: Store | null = null;
let gloo: GlooClient | null = null;

async function bootstrap(): Promise<{
  config: Config;
  store: Store;
  gloo: GlooClient;
}> {
  config ??= loadConfig();
  store ??= createStore(config.tableName);
  gloo ??= createGlooClient({
    apiKey: await loadGlooApiKey(config.glooApiKeySecretId),
  });
  return { config, store, gloo };
}

function respond(
  stream: ResponseStream,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const output = awslambda.HttpResponseStream.from(stream, {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
  output.write(JSON.stringify(body));
  output.end();
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Record the call, never letting a persistence failure break the response. */
async function persist(
  store: Store,
  metrics: CallMetrics,
  trace: ReturnType<typeof toVisitorTrace>,
  session?: { id: string; messages: ChatMessage[] }
): Promise<void> {
  await Promise.allSettled([
    store.recordCall(metrics, trace),
    session
      ? store.saveSession(session.id, session.messages, trace)
      : Promise.resolve(),
  ]);
}

async function handleChat(
  stream: ResponseStream,
  body: unknown,
  store: Store,
  gloo: GlooClient,
  visitor: VisitorContext
): Promise<void> {
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    respond(
      stream,
      400,
      { error: parsed.error.issues[0]?.message ?? "invalid" },
      visitorHeaders(visitor)
    );
    return;
  }

  const { sessionId, messages, routing } = parsed.data;
  const trace = toVisitorTrace(visitor, sessionId);
  const output = awslambda.HttpResponseStream.from(stream, {
    statusCode: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      // A streamed Function URL response can still carry response headers,
      // and they are written before the first token, so the cookie lands on
      // the chat request rather than waiting for the next non-streaming one.
      ...visitorHeaders(visitor),
    },
  });

  const pricing = await loadRegistry();
  const accumulator = createAccumulator();
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  try {
    for await (const delta of gloo.stream(messages, routing, accumulator)) {
      output.write(sseFrame({ type: "delta", text: delta }));
    }
    const metrics = toMetrics({
      requestId,
      selection: routing,
      accumulator,
      latencyMs: Date.now() - startedAt,
      pricing,
    });
    output.write(sseFrame({ type: "meta", metrics }));
    await persist(store, metrics, trace, {
      id: sessionId,
      messages: [
        ...messages,
        { role: "assistant" as const, content: accumulator.text },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "upstream failure";
    output.write(sseFrame({ type: "error", message }));
    await persist(
      store,
      toMetrics({
        requestId,
        selection: routing,
        accumulator,
        latencyMs: Date.now() - startedAt,
        pricing,
        status: "error",
        errorMessage: message,
      }),
      trace
    );
  } finally {
    output.write("data: [DONE]\n\n");
    output.end();
  }
}

async function runVariant(
  prompt: string,
  selection: RoutingSelection,
  gloo: GlooClient,
  pricing: Awaited<ReturnType<typeof loadRegistry>>
): Promise<CallMetrics & { text: string }> {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const accumulator = await gloo.complete(
      [{ role: "user", content: prompt }],
      selection
    );
    return {
      ...toMetrics({
        requestId,
        selection,
        accumulator,
        latencyMs: Date.now() - startedAt,
        pricing,
      }),
      text: accumulator.text,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "upstream failure";
    return {
      ...toMetrics({
        requestId,
        selection,
        accumulator: createAccumulator(),
        latencyMs: Date.now() - startedAt,
        pricing,
        status: "error",
        errorMessage: message,
      }),
      text: "",
    };
  }
}

async function handleCompare(
  stream: ResponseStream,
  body: unknown,
  store: Store,
  gloo: GlooClient,
  visitor: VisitorContext
): Promise<void> {
  const parsed = compareRequestSchema.safeParse(body);
  if (!parsed.success) {
    respond(
      stream,
      400,
      { error: parsed.error.issues[0]?.message ?? "invalid" },
      visitorHeaders(visitor)
    );
    return;
  }

  const trace = toVisitorTrace(visitor, parsed.data.sessionId);
  const pricing = await loadRegistry();
  const results = await Promise.all(
    parsed.data.variants.map((selection) =>
      runVariant(parsed.data.prompt, selection, gloo, pricing)
    )
  );

  await Promise.allSettled(
    results.map(({ text: _text, ...metrics }) =>
      store.recordCall(metrics, trace)
    )
  );

  respond(stream, 200, { results }, visitorHeaders(visitor));
}

async function handleLedger(
  stream: ResponseStream,
  store: Store,
  visitor: VisitorContext
): Promise<void> {
  const rows = await store.recentCalls(LEDGER_PAGE_SIZE);
  respond(
    stream,
    200,
    { rows, rollups: rollupByModel(rows) },
    visitorHeaders(visitor)
  );
}

/**
 * The only cacheable response here, and so the only one that deliberately
 * carries no `Set-Cookie`: a browser replaying a cached model list must not
 * replay a cookie with it. The next uncached call issues the cookie instead.
 */
async function handleModels(stream: ResponseStream): Promise<void> {
  const pricing = await loadRegistry();
  const models: ModelSummary[] = [...pricing.values()].map((entry) => ({
    id: entry.id,
    name: entry.name,
    family: entry.family,
    inputRatePerMillion: entry.inputRatePerMillion,
    outputRatePerMillion: entry.outputRatePerMillion,
  }));
  respond(stream, 200, { models }, { "Cache-Control": "max-age=300" });
}

async function handleSession(
  stream: ResponseStream,
  event: LambdaFunctionURLEvent,
  store: Store,
  visitor: VisitorContext
): Promise<void> {
  const sessionId = event.queryStringParameters?.id;
  if (!sessionId || !/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) {
    respond(
      stream,
      400,
      { error: "invalid session id" },
      visitorHeaders(visitor)
    );
    return;
  }
  respond(
    stream,
    200,
    { messages: await store.loadSession(sessionId) },
    visitorHeaders(visitor)
  );
}

function decodeBody(event: LambdaFunctionURLEvent): unknown {
  if (!event.body) {
    return null;
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const handler = awslambda.streamifyResponse(
  async (event: LambdaFunctionURLEvent, responseStream: ResponseStream) => {
    let deps: Awaited<ReturnType<typeof bootstrap>>;
    try {
      deps = await bootstrap();
    } catch (error) {
      respond(responseStream, 500, {
        error: error instanceof Error ? error.message : "configuration error",
      });
      return;
    }

    if (event.headers?.["x-demo-origin"] !== deps.config.originSecret) {
      respond(responseStream, 403, { error: "forbidden" });
      return;
    }

    const method = event.requestContext.http.method;
    const path = event.rawPath;

    // Resolved after the origin check so a rejected request is never issued
    // an identity, and before routing so every accepted route can carry the
    // cookie. This never throws and never depends on the request being
    // valid, which is what keeps the no-cookie path indistinguishable from
    // the cookie path as far as the user is concerned.
    const visitor = resolveVisitor(event, deps.config.visitorSalt);

    try {
      if (method === "POST" && path === "/api/chat") {
        await handleChat(
          responseStream,
          decodeBody(event),
          deps.store,
          deps.gloo,
          visitor
        );
        return;
      }
      if (method === "POST" && path === "/api/compare") {
        await handleCompare(
          responseStream,
          decodeBody(event),
          deps.store,
          deps.gloo,
          visitor
        );
        return;
      }
      if (method === "GET" && path === "/api/ledger") {
        await handleLedger(responseStream, deps.store, visitor);
        return;
      }
      if (method === "GET" && path === "/api/models") {
        await handleModels(responseStream);
        return;
      }
      if (method === "GET" && path === "/api/session") {
        await handleSession(responseStream, event, deps.store, visitor);
        return;
      }
      respond(responseStream, 404, { error: "not found" });
    } catch (error) {
      respond(responseStream, 500, {
        error: error instanceof Error ? error.message : "unhandled error",
      });
    }
  }
);
