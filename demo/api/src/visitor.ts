/**
 * Anonymous visitor identity and per-request technical metadata.
 *
 * Why this lives in the Lambda and not in a CloudFront function
 * -------------------------------------------------------------
 * There are three places a cookie could be minted:
 *
 *   1. `functions/basic-auth.js`, a viewer-request function. It runs before
 *      the origin, so it can only mutate the *request*. It cannot attach a
 *      `Set-Cookie` to the response at all.
 *   2. A second CloudFront function on viewer-response. That could set the
 *      cookie on the very first HTML load, but CloudFront Functions have no
 *      `crypto`, so the id would come from `Math.random()`, and it would be
 *      a second published function plus a second cache-behavior association
 *      to maintain.
 *   3. This handler.
 *
 * This handler wins. It is the only component that writes the DynamoDB rows
 * the id is a trace key *for*, it has real `crypto.randomUUID()`, and the
 * static asset loads a viewer-response function would cover produce no rows
 * to correlate anyway. The cost is that a visitor who loads the page and
 * never sends a prompt is never issued an id, which is exactly the visitor
 * there is nothing to trace.
 *
 * What is captured
 * ----------------
 * Technical signals only: an opaque random id, a salted hash of the client
 * IP, the User-Agent string, and the request timestamp the caller already
 * has. Nothing is derived from message text. The chat transcript is stored
 * separately and only so the SPA can replay a conversation after a refresh.
 *
 * The IP is hashed rather than stored raw. Correlating "these calls came
 * from one network" and spotting one client hammering the demo both work off
 * a hash; recovering the address itself has no use here, so it is not kept.
 * The salt is a Terraform-generated per-deployment random value, so the
 * hashes are not reversible by rainbow table and do not survive a redeploy.
 *
 * Cookies are strictly optional
 * -----------------------------
 * Nothing in the request path depends on the cookie existing. If it is
 * absent (first call, Safari private browsing, ITP, a blocker, or a user who
 * just cleared cookies) a fresh id is minted for this request and marked
 * `issued` rather than `cookie`, so a reader can tell a durable
 * cross-session id from one that may never be seen again. The SPA's
 * localStorage session id is recorded next to it as the fallback correlator.
 */
import { createHash, randomUUID } from "node:crypto";
import type { LambdaFunctionURLEvent } from "aws-lambda";

/** First-party cookie carrying the opaque anonymous visitor id. */
export const VISITOR_COOKIE_NAME = "gloo_demo_vid";

/** Weeks, not years. This is a proof of concept, not an ad network. */
export const VISITOR_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** `v-` plus 32 lowercase hex characters. */
const VISITOR_ID_PATTERN = /^v-[0-9a-f]{32}$/;

/** Long enough to distinguish clients, short enough to stay a fingerprint. */
const IP_HASH_LENGTH = 16;

/** User-Agent strings are unbounded; keep a usable prefix, not a blob. */
const USER_AGENT_MAX_LENGTH = 256;

/**
 * Where the id in a request came from.
 *
 * - `cookie`: the browser sent it back, so it is durable across sessions.
 * - `issued`: minted for this request. It may stick, or the browser may
 *   drop it and the next request mints another. Never treat it as durable.
 */
export type VisitorIdSource = "cookie" | "issued";

export type VisitorContext = {
  visitorId: string;
  visitorIdSource: VisitorIdSource;
  /** Salted, truncated SHA-256 of the client IP. Null if no IP was found. */
  ipHash: string | null;
  userAgent: string | null;
  /** Set only when a new id was minted, so responses can carry the cookie. */
  setCookie?: string;
};

/** What gets written alongside a DynamoDB row for correlation. */
export type VisitorTrace = {
  visitor_id: string;
  visitor_id_source: VisitorIdSource;
  visitor_ip_hash?: string;
  visitor_user_agent?: string;
  /** The SPA's localStorage id. The fallback key when cookies are blocked. */
  visitor_session_id?: string;
};

export function mintVisitorId(): string {
  return `v-${randomUUID().replace(/-/g, "")}`;
}

export function isVisitorId(value: string): boolean {
  return VISITOR_ID_PATTERN.test(value);
}

/**
 * Parse a `Cookie` request header. Last value wins, matching how browsers
 * treat a duplicate name in a single header. Malformed pairs are skipped
 * rather than throwing: a junk cookie from some other tool on the domain
 * must not be able to fail a request.
 */
export function parseCookieHeader(
  header: string | undefined
): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name.length > 0) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

/**
 * Read the visitor id a browser sent back. Function URL events expose
 * cookies twice, as a `cookies` array and as the raw `cookie` header, and
 * which one is populated depends on the payload version, so both are read.
 * An id that does not match the minted format is ignored rather than
 * trusted: this value ends up in a DynamoDB attribute, so it is treated as
 * untrusted input like any other header.
 */
export function readVisitorCookie(
  event: LambdaFunctionURLEvent
): string | null {
  const candidates = new Map<string, string>();
  for (const entry of event.cookies ?? []) {
    for (const [name, value] of parseCookieHeader(entry)) {
      candidates.set(name, value);
    }
  }
  for (const [name, value] of parseCookieHeader(event.headers?.cookie)) {
    candidates.set(name, value);
  }
  const id = candidates.get(VISITOR_COOKIE_NAME);
  return id && isVisitorId(id) ? id : null;
}

/**
 * Serialise the `Set-Cookie` value.
 *
 * `HttpOnly` because nothing in the SPA reads this: the browser attaches it
 * to the same-origin `/api/*` calls and the Lambda reads it there.
 *
 * `SameSite=Lax` rather than `Strict`. Both work for the app itself, whose
 * every request is same-origin XHR from a page on the same host. `Lax` is
 * chosen so the cookie is still attached when someone opens the demo link
 * from a chat message or an email, which is how this demo actually gets
 * visited, and which is precisely the continuity the id exists to provide.
 */
export function visitorCookie(
  visitorId: string,
  maxAgeSeconds = VISITOR_COOKIE_MAX_AGE_SECONDS
): string {
  return [
    `${VISITOR_COOKIE_NAME}=${visitorId}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

/**
 * The viewer's IP. CloudFront terminates the connection, so
 * `requestContext.http.sourceIp` is a CloudFront edge address; the viewer
 * address is the first entry of `X-Forwarded-For`, which CloudFront sets.
 * The direct `sourceIp` is the fallback for a request that somehow reached
 * the Function URL without going through the distribution.
 */
export function clientIp(event: LambdaFunctionURLEvent): string | null {
  const forwarded = event.headers?.["x-forwarded-for"];
  const first = forwarded?.split(",")[0]?.trim();
  if (first) {
    return first;
  }
  return event.requestContext?.http?.sourceIp || null;
}

/** Salted, truncated SHA-256. Not reversible, not portable across deploys. */
export function hashIp(ip: string | null, salt: string): string | null {
  if (!ip) {
    return null;
  }
  return createHash("sha256")
    .update(`${salt}:${ip}`)
    .digest("hex")
    .slice(0, IP_HASH_LENGTH);
}

function readUserAgent(event: LambdaFunctionURLEvent): string | null {
  const raw = event.headers?.["user-agent"]?.trim();
  if (!raw) {
    return null;
  }
  return raw.slice(0, USER_AGENT_MAX_LENGTH);
}

/**
 * Resolve the visitor for one request. Never throws and never rejects a
 * request: the worst case is a freshly minted id with no IP hash.
 */
export function resolveVisitor(
  event: LambdaFunctionURLEvent,
  salt: string
): VisitorContext {
  const existing = readVisitorCookie(event);
  const visitorId = existing ?? mintVisitorId();
  return {
    visitorId,
    visitorIdSource: existing ? "cookie" : "issued",
    ipHash: hashIp(clientIp(event), salt),
    userAgent: readUserAgent(event),
    // Re-offered on every request that arrived without a usable cookie, so
    // a client that starts accepting cookies later picks one up without any
    // special case, and a client that never does simply keeps ignoring it.
    ...(existing ? {} : { setCookie: visitorCookie(visitorId) }),
  };
}

/** Response headers that carry a newly minted cookie, or none. */
export function visitorHeaders(
  visitor: VisitorContext
): Record<string, string> {
  return visitor.setCookie ? { "Set-Cookie": visitor.setCookie } : {};
}

/**
 * Flatten a visitor into DynamoDB attributes. Attributes with no value are
 * omitted entirely rather than written as null, so "we did not capture a
 * User-Agent" and "the User-Agent was empty" are not the same row.
 */
export function toVisitorTrace(
  visitor: VisitorContext,
  sessionId?: string
): VisitorTrace {
  return {
    visitor_id: visitor.visitorId,
    visitor_id_source: visitor.visitorIdSource,
    ...(visitor.ipHash ? { visitor_ip_hash: visitor.ipHash } : {}),
    ...(visitor.userAgent ? { visitor_user_agent: visitor.userAgent } : {}),
    ...(sessionId ? { visitor_session_id: sessionId } : {}),
  };
}
