/**
 * HTTP server for the Gloo AI demo API.
 *
 * Runs as a long-lived container on ECS Fargate behind the shared `genesis`
 * ALB. It used to be a Lambda behind a Function URL in RESPONSE_STREAM
 * invoke mode; the account's org guardrails block CloudFront from invoking a
 * Function URL at all, and every buffered alternative (API Gateway,
 * ALB-to-Lambda) would have cost `/api/chat` its token-by-token streaming,
 * which is the entire point of the Chat panel. A container writing straight
 * into a chunked HTTP response keeps that and drops the runtime-specific
 * `awslambda.HttpResponseStream` shim.
 *
 * `node:http` rather than a framework: the surface is a handful of fixed routes with
 * hand-written JSON bodies, and the one route that matters streams raw
 * frames into the socket, which is exactly the layer any framework would
 * have to be talked out of the way of.
 *
 * The frontend is a static SPA on S3/CloudFront and holds no credentials.
 * Every Gloo call goes through here, where the API key is read from Secrets
 * Manager once at startup.
 *
 * This is also where the anonymous visitor cookie is minted and read, since
 * it is the only layer that both has real crypto and writes the rows the id
 * exists to correlate. See `visitor.ts` for that reasoning in full. Nothing
 * on any route depends on the cookie being present.
 */
import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Config } from "./config.js";
import { createAccumulator, toMetrics, type GlooClient } from "./gloo.js";
import { rollupByModel } from "./ledger.js";
import { createRegistryLoader } from "./pricing.js";
import {
  chatRequestSchema,
  compareRequestSchema,
  sessionPatchSchema,
} from "./routing.js";
import type { Store } from "./store.js";
import {
  normalizeTitle,
  shouldGenerateTitle,
  titlePromptMessages,
} from "./title.js";
import type {
  CallMetrics,
  ChatMessage,
  ModelSummary,
  RoutingSelection,
} from "./types.js";
import {
  resolveVisitor,
  toVisitorTrace,
  visitorHeaders,
  type VisitorContext,
} from "./visitor.js";

/**
 * Deep enough that a rolling average over the Observed view's trend charts
 * has something to smooth, small enough that the response stays well under
 * a hundred kilobytes of small rows.
 */
const LEDGER_PAGE_SIZE = 200;

/**
 * Nothing here takes a large body: the biggest is a chat transcript. Capping
 * the read means a client cannot make the process buffer without bound.
 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Conversations expire after twelve hours, so a visitor's history is short by
 * construction; this only bounds the pathological case.
 */
const SESSION_PAGE_SIZE = 50;

/**
 * The ALB's own idle timeout is 60s and it, not the target, is meant to
 * close an idle connection first. A target that closes at Node's default 5s
 * races the ALB reusing that connection, which surfaces as sporadic 502s.
 */
const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const HEADERS_TIMEOUT_MS = 66_000;

const loadRegistry = createRegistryLoader();

export type ServerDeps = {
  config: Config;
  store: Store;
  gloo: GlooClient;
};

function respond(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Read and JSON-parse a request body. Returns null for an absent, oversized,
 * or unparseable body; every caller validates with zod immediately after, so
 * all three collapse into the same 400.
 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
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

/**
 * The routing used to name a conversation. Auto routing rather than a pinned
 * model id, both because it is what this demo is demonstrating and because a
 * six-word title is exactly the trivial prompt auto routing is meant to send
 * to the cheap tier.
 */
const TITLE_ROUTING: RoutingSelection = { mode: "auto_routing" };

/**
 * Name a conversation from its first exchange and store the result.
 *
 * Never awaited by the request that triggers it: this is a second, real,
 * billed Gloo call, and the visitor's answer has already been streamed and
 * closed by the time it starts. Every failure is swallowed for the same
 * reason a ledger write failure is - a chat that worked must not be reported
 * as broken because the cosmetic label on its history entry could not be
 * produced.
 *
 * Deliberately not written to the ledger. The Observed view is a record of
 * the calls the Chat and Compare panels made on a visitor's behalf, and
 * folding a twelve-token housekeeping call into the per-model latency and
 * cost averages would misreport what those two panels actually cost.
 */
async function nameSession(
  store: Store,
  gloo: GlooClient,
  visitorId: string,
  sessionId: string,
  messages: ChatMessage[],
  reply: string
): Promise<void> {
  try {
    const accumulator = await gloo.complete(
      titlePromptMessages(messages, reply),
      TITLE_ROUTING
    );
    const title = normalizeTitle(accumulator.text);
    if (title) {
      await store.applyGeneratedTitle(visitorId, sessionId, title);
    }
  } catch (error) {
    console.error(
      "title generation failed",
      error instanceof Error ? error.message : error
    );
  }
}

async function handleChat(
  response: ServerResponse,
  body: unknown,
  store: Store,
  gloo: GlooClient,
  visitor: VisitorContext
): Promise<void> {
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    respond(
      response,
      400,
      { error: parsed.error.issues[0]?.message ?? "invalid" },
      visitorHeaders(visitor)
    );
    return;
  }

  const { sessionId, messages, routing } = parsed.data;
  const trace = toVisitorTrace(visitor, sessionId);

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    // Headers go out before the first token, so the cookie lands on the chat
    // request rather than waiting for the next non-streaming one.
    ...visitorHeaders(visitor),
  });
  // Without this Node holds the head back until the first body write is
  // large enough to flush, which delays time to first token.
  response.flushHeaders();

  const pricing = await loadRegistry();
  const accumulator = createAccumulator();
  const requestId = randomUUID();
  const startedAt = Date.now();

  try {
    for await (const delta of gloo.stream(messages, routing, accumulator)) {
      response.write(sseFrame({ type: "delta", text: delta }));
    }
    const metrics = toMetrics({
      requestId,
      selection: routing,
      accumulator,
      latencyMs: Date.now() - startedAt,
      pricing,
    });
    response.write(sseFrame({ type: "meta", metrics }));
    await persist(store, metrics, trace, {
      id: sessionId,
      messages: [
        ...messages,
        { role: "assistant" as const, content: accumulator.text },
      ],
    });
    // Gated on the transcript this request carries rather than on anything
    // the client asserts, so a conversation is named once, on its first
    // completed reply, whatever the client believes about its own state.
    if (trace.visitor_id && shouldGenerateTitle(messages)) {
      void nameSession(
        store,
        gloo,
        trace.visitor_id,
        sessionId,
        messages,
        accumulator.text
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "upstream failure";
    response.write(sseFrame({ type: "error", message }));
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
    response.end("data: [DONE]\n\n");
  }
}

async function runVariant(
  prompt: string,
  selection: RoutingSelection,
  gloo: GlooClient,
  pricing: Awaited<ReturnType<typeof loadRegistry>>
): Promise<CallMetrics & { text: string }> {
  const requestId = randomUUID();
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
  response: ServerResponse,
  body: unknown,
  store: Store,
  gloo: GlooClient,
  visitor: VisitorContext
): Promise<void> {
  const parsed = compareRequestSchema.safeParse(body);
  if (!parsed.success) {
    respond(
      response,
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

  respond(response, 200, { results }, visitorHeaders(visitor));
}

async function handleLedger(
  response: ServerResponse,
  store: Store,
  visitor: VisitorContext
): Promise<void> {
  const rows = await store.recentCalls(LEDGER_PAGE_SIZE);
  respond(
    response,
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
async function handleModels(response: ServerResponse): Promise<void> {
  const pricing = await loadRegistry();
  const models: ModelSummary[] = [...pricing.values()].map((entry) => ({
    id: entry.id,
    name: entry.name,
    family: entry.family,
    inputRatePerMillion: entry.inputRatePerMillion,
    outputRatePerMillion: entry.outputRatePerMillion,
  }));
  respond(response, 200, { models }, { "Cache-Control": "max-age=300" });
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function readSessionId(url: URL): string | null {
  const sessionId = url.searchParams.get("id");
  return sessionId && SESSION_ID_PATTERN.test(sessionId) ? sessionId : null;
}

async function handleSession(
  response: ServerResponse,
  url: URL,
  store: Store,
  visitor: VisitorContext
): Promise<void> {
  const sessionId = readSessionId(url);
  if (!sessionId) {
    respond(
      response,
      400,
      { error: "invalid session id" },
      visitorHeaders(visitor)
    );
    return;
  }
  respond(
    response,
    200,
    { messages: await store.loadSession(sessionId) },
    visitorHeaders(visitor)
  );
}

/**
 * Pin, rename, or archive one of the caller's own conversations. The change
 * lands on the summary row in the caller's visitor partition, so a caller can
 * only ever act on a conversation their own history already lists; anything
 * else is a 404 and not a write.
 *
 * Archiving is a soft delete and the only kind offered: the transcript stays
 * in the table and expires on the same twelve-hour TTL as every other
 * conversation, so "archived" changes which list a conversation appears in
 * and nothing about how long it is kept.
 */
async function handleSessionPatch(
  response: ServerResponse,
  url: URL,
  body: unknown,
  store: Store,
  visitor: VisitorContext
): Promise<void> {
  const sessionId = readSessionId(url);
  if (!sessionId) {
    respond(
      response,
      400,
      { error: "invalid session id" },
      visitorHeaders(visitor)
    );
    return;
  }
  const parsed = sessionPatchSchema.safeParse(body);
  if (!parsed.success) {
    respond(
      response,
      400,
      { error: parsed.error.issues[0]?.message ?? "invalid" },
      visitorHeaders(visitor)
    );
    return;
  }

  const patch = { ...parsed.data };
  if (patch.title !== undefined) {
    const title = normalizeTitle(patch.title);
    if (!title) {
      respond(
        response,
        400,
        { error: "invalid title" },
        visitorHeaders(visitor)
      );
      return;
    }
    patch.title = title;
  }

  const changed = await store.patchSession(visitor.visitorId, sessionId, patch);
  if (!changed) {
    respond(response, 404, { error: "not found" }, visitorHeaders(visitor));
    return;
  }
  respond(response, 200, { ok: true }, visitorHeaders(visitor));
}

/**
 * The conversations belonging to the caller's own visitor id. The id comes
 * from the cookie and never from the query string, so this route cannot be
 * used to read someone else's history by guessing an id.
 *
 * `?archived=1` returns the archived ones instead of hiding them, which is
 * what makes archiving recoverable rather than a delete with a longer name.
 */
async function handleSessions(
  response: ServerResponse,
  url: URL,
  store: Store,
  visitor: VisitorContext
): Promise<void> {
  respond(
    response,
    200,
    {
      sessions: await store.listSessions(
        visitor.visitorId,
        SESSION_PAGE_SIZE,
        url.searchParams.get("archived") === "1"
      ),
    },
    visitorHeaders(visitor)
  );
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ServerDeps
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";
  const path = url.pathname;

  // The ALB health check comes straight off the load balancer and cannot
  // carry the shared origin header, so it is answered before that check and
  // is deliberately the only unauthenticated route. It reports process
  // liveness only: a Gloo or DynamoDB outage should not make ECS replace an
  // otherwise healthy task.
  if (method === "GET" && path === "/healthz") {
    respond(response, 200, { status: "ok" });
    return;
  }

  // Defense in depth rather than the gate it was under the Function URL:
  // this service sits behind a shared, internet-facing ALB, so the header is
  // what distinguishes traffic that came through our distribution from
  // anyone who finds the origin hostname.
  if (request.headers["x-demo-origin"] !== deps.config.originSecret) {
    respond(response, 403, { error: "forbidden" });
    return;
  }

  // Resolved after the origin check so a rejected request is never issued an
  // identity, and before routing so every accepted route can carry the
  // cookie. This never throws and never depends on the request being valid,
  // which is what keeps the no-cookie path indistinguishable from the cookie
  // path as far as the user is concerned.
  const visitor = resolveVisitor(request, deps.config.visitorSalt);

  if (method === "POST" && path === "/api/chat") {
    await handleChat(
      response,
      await readJsonBody(request),
      deps.store,
      deps.gloo,
      visitor
    );
    return;
  }
  if (method === "POST" && path === "/api/compare") {
    await handleCompare(
      response,
      await readJsonBody(request),
      deps.store,
      deps.gloo,
      visitor
    );
    return;
  }
  if (method === "GET" && path === "/api/ledger") {
    await handleLedger(response, deps.store, visitor);
    return;
  }
  if (method === "GET" && path === "/api/models") {
    await handleModels(response);
    return;
  }
  if (method === "GET" && path === "/api/session") {
    await handleSession(response, url, deps.store, visitor);
    return;
  }
  if (method === "PATCH" && path === "/api/session") {
    await handleSessionPatch(
      response,
      url,
      await readJsonBody(request),
      deps.store,
      visitor
    );
    return;
  }
  if (method === "GET" && path === "/api/sessions") {
    await handleSessions(response, url, deps.store, visitor);
    return;
  }
  respond(response, 404, { error: "not found" });
}

export function createServer(deps: ServerDeps): Server {
  const server = createHttpServer((request, response) => {
    void route(request, response, deps).catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "unhandled error";
      console.error("request failed", message);
      // A streaming response is already committed by the time most failures
      // land, so there is no status left to send; just close it.
      if (response.headersSent) {
        response.end();
        return;
      }
      respond(response, 500, { error: message });
    });
  });

  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}
