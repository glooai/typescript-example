import { describe, expect, it } from "vitest";
import type { VisitorRequest } from "../src/visitor.js";
import {
  VISITOR_COOKIE_MAX_AGE_SECONDS,
  VISITOR_COOKIE_NAME,
  clientIp,
  hashIp,
  isVisitorId,
  mintVisitorId,
  parseCookieHeader,
  readVisitorCookie,
  resolveVisitor,
  toVisitorTrace,
  visitorCookie,
  visitorHeaders,
} from "../src/visitor.js";

const SALT = "test-salt";
const KNOWN_ID = "v-0123456789abcdef0123456789abcdef";

function request(
  overrides: {
    headers?: Record<string, string>;
    sourceIp?: string;
  } = {}
): VisitorRequest {
  return {
    headers: overrides.headers ?? {},
    socket: { remoteAddress: overrides.sourceIp },
  };
}

describe("parseCookieHeader", () => {
  it("splits a cookie header into name/value pairs", () => {
    const cookies = parseCookieHeader("a=1; b=two; c=three");

    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("b")).toBe("two");
    expect(cookies.get("c")).toBe("three");
  });

  it("keeps values that themselves contain an equals sign", () => {
    expect(parseCookieHeader("token=abc=def").get("token")).toBe("abc=def");
  });

  it("skips malformed pairs instead of throwing", () => {
    const cookies = parseCookieHeader("; =novalue; noequals; good=yes; ");

    expect(cookies.get("good")).toBe("yes");
    expect(cookies.size).toBe(1);
  });

  it("returns an empty map for an absent header", () => {
    expect(parseCookieHeader(undefined).size).toBe(0);
  });
});

describe("readVisitorCookie", () => {
  it("reads the id from the cookie header", () => {
    const found = readVisitorCookie(
      request({ headers: { cookie: `${VISITOR_COOKIE_NAME}=${KNOWN_ID}` } })
    );

    expect(found).toBe(KNOWN_ID);
  });

  it("ignores a value that is not a minted id", () => {
    for (const value of ["", "not-an-id", "v-short", `${KNOWN_ID}extra`]) {
      expect(
        readVisitorCookie(
          request({ headers: { cookie: `${VISITOR_COOKIE_NAME}=${value}` } })
        )
      ).toBeNull();
    }
  });

  it("returns null when the visitor cookie is absent", () => {
    expect(readVisitorCookie(request({ headers: { cookie: "other=1" } }))).toBe(
      null
    );
    expect(readVisitorCookie(request())).toBeNull();
  });
});

describe("mintVisitorId", () => {
  it("mints ids in the format the reader accepts", () => {
    const id = mintVisitorId();

    expect(isVisitorId(id)).toBe(true);
    expect(id).not.toBe(mintVisitorId());
  });
});

describe("visitorCookie", () => {
  it("is first-party, opaque, and expires in weeks", () => {
    const cookie = visitorCookie(KNOWN_ID);

    expect(cookie).toContain(`${VISITOR_COOKIE_NAME}=${KNOWN_ID}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(VISITOR_COOKIE_MAX_AGE_SECONDS).toBeLessThan(90 * 24 * 60 * 60);
  });
});

describe("clientIp", () => {
  it("prefers the first X-Forwarded-For entry, which CloudFront sets", () => {
    const found = clientIp(
      request({
        headers: { "x-forwarded-for": "203.0.113.7, 70.132.1.1" },
        sourceIp: "70.132.1.1",
      })
    );

    expect(found).toBe("203.0.113.7");
  });

  it("falls back to the direct source IP when there is no forwarded header", () => {
    expect(clientIp(request({ sourceIp: "198.51.100.4" }))).toBe(
      "198.51.100.4"
    );
  });

  it("returns null when neither is available", () => {
    expect(clientIp(request())).toBeNull();
  });
});

describe("hashIp", () => {
  it("is stable for one address and salt, and short", () => {
    const hash = hashIp("203.0.113.7", SALT);

    expect(hash).toBe(hashIp("203.0.113.7", SALT));
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not contain the address it was derived from", () => {
    expect(hashIp("203.0.113.7", SALT)).not.toContain("203.0.113.7");
  });

  it("differs per address and per salt", () => {
    expect(hashIp("203.0.113.7", SALT)).not.toBe(hashIp("203.0.113.8", SALT));
    expect(hashIp("203.0.113.7", SALT)).not.toBe(
      hashIp("203.0.113.7", "other-salt")
    );
  });

  it("returns null when there was no address", () => {
    expect(hashIp(null, SALT)).toBeNull();
  });
});

describe("resolveVisitor with a cookie", () => {
  const visitor = resolveVisitor(
    request({
      headers: {
        cookie: `${VISITOR_COOKIE_NAME}=${KNOWN_ID}`,
        "user-agent": "Mozilla/5.0 (Macintosh)",
        "x-forwarded-for": "203.0.113.7",
      },
    }),
    SALT
  );

  it("reuses the durable id and marks it as such", () => {
    expect(visitor.visitorId).toBe(KNOWN_ID);
    expect(visitor.visitorIdSource).toBe("cookie");
  });

  it("does not re-issue a cookie the browser already holds", () => {
    expect(visitor.setCookie).toBeUndefined();
    expect(visitorHeaders(visitor)).toEqual({});
  });

  it("captures technical signals only", () => {
    expect(visitor.userAgent).toBe("Mozilla/5.0 (Macintosh)");
    expect(visitor.ipHash).toBe(hashIp("203.0.113.7", SALT));
  });

  it("truncates an overlong User-Agent", () => {
    const long = resolveVisitor(
      request({ headers: { "user-agent": "u".repeat(1000) } }),
      SALT
    );

    expect(long.userAgent).toHaveLength(256);
  });
});

describe("resolveVisitor without a cookie", () => {
  it("mints an id, offers the cookie, and flags it as not yet durable", () => {
    const visitor = resolveVisitor(request({ sourceIp: "198.51.100.4" }), SALT);

    expect(isVisitorId(visitor.visitorId)).toBe(true);
    expect(visitor.visitorIdSource).toBe("issued");
    expect(visitor.setCookie).toContain(visitor.visitorId);
    expect(visitorHeaders(visitor)["Set-Cookie"]).toBe(visitor.setCookie);
  });

  it("keeps working for a client that never stores the cookie", () => {
    // Two requests from a browser that drops the cookie every time. Both
    // still resolve, both still carry technical metadata, and neither one
    // claims a durable identity.
    const blocked = request({
      headers: {
        "user-agent": "Safari/private",
        "x-forwarded-for": "203.0.113.7",
      },
    });
    const first = resolveVisitor(blocked, SALT);
    const second = resolveVisitor(blocked, SALT);

    expect(first.visitorId).not.toBe(second.visitorId);
    expect(first.visitorIdSource).toBe("issued");
    expect(second.visitorIdSource).toBe("issued");
    expect(first.ipHash).toBe(second.ipHash);
    expect(second.userAgent).toBe("Safari/private");
  });

  it("still resolves when there is no IP, no User-Agent, and no headers", () => {
    const visitor = resolveVisitor(request(), SALT);

    expect(isVisitorId(visitor.visitorId)).toBe(true);
    expect(visitor.ipHash).toBeNull();
    expect(visitor.userAgent).toBeNull();
  });
});

describe("toVisitorTrace", () => {
  it("carries the session id as the fallback correlator", () => {
    const visitor = resolveVisitor(
      request({
        headers: { "user-agent": "curl/8", "x-forwarded-for": "203.0.113.7" },
      }),
      SALT
    );
    const trace = toVisitorTrace(visitor, "s-abcdef1234");

    expect(trace).toEqual({
      visitor_id: visitor.visitorId,
      visitor_id_source: "issued",
      visitor_ip_hash: hashIp("203.0.113.7", SALT),
      visitor_user_agent: "curl/8",
      visitor_session_id: "s-abcdef1234",
    });
  });

  it("omits attributes it has no value for rather than writing nulls", () => {
    const trace = toVisitorTrace(resolveVisitor(request(), SALT));

    expect(Object.keys(trace).sort()).toEqual([
      "visitor_id",
      "visitor_id_source",
    ]);
  });
});
