import { expect, it, vi, beforeEach, afterEach } from "vitest";
import * as gloo from "../src/index";

type FetchCall = {
  url?: string | URL;
  init?: RequestInit;
};

const base64Url = (value: string): string =>
  Buffer.from(value).toString("base64url");

const originalEnv = { ...process.env };

const mockFetch = (payload: unknown): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

it("loads credentials from the environment", () => {
  process.env.GLOO_AI_CLIENT_ID = "abc";
  process.env.GLOO_AI_CLIENT_SECRET = "xyz";

  const creds = gloo.loadCredentials();

  expect(creds).toEqual({ clientId: "abc", clientSecret: "xyz" });
});

it("throws when credentials are missing", () => {
  delete process.env.GLOO_AI_CLIENT_ID;
  delete process.env.GLOO_AI_CLIENT_SECRET;

  expect(() => gloo.loadCredentials()).toThrow(
    /Missing GLOO_AI_CLIENT_ID environment variable/
  );
});

it("posts form data for access tokens", async () => {
  const calls: FetchCall = {};
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      calls.url = url;
      calls.init = init;
      return mockFetch({ access_token: "token123" });
    });

  const token = await gloo.getAccessToken({
    clientId: "client-id",
    clientSecret: "client-secret",
  });

  expect(token.access_token).toBe("token123");
  expect(calls.url).toBe("https://platform.ai.gloo.com/oauth2/token");
  expect(calls.init?.method).toBe("POST");
  expect(calls.init?.headers).toMatchObject({
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: expect.stringContaining("Basic "),
  });
  expect((calls.init?.body as URLSearchParams).toString()).toBe(
    "grant_type=client_credentials&scope=api%2Faccess"
  );
  fetchSpy.mockRestore();
});

it("posts chat completions with the given prompt", async () => {
  const calls: FetchCall = {};
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      calls.url = url;
      calls.init = init;
      return mockFetch({
        choices: [{ message: { content: "hello" } }],
      });
    });

  const response = await gloo.getChatCompletion("token123", "Hi there!");

  expect(response.choices[0].message.content).toBe("hello");
  expect(calls.url).toBe("https://platform.ai.gloo.com/ai/v1/chat/completions");
  expect(calls.init?.headers).toMatchObject({
    Authorization: "Bearer token123",
    "Content-Type": "application/json",
  });
  const parsedBody = JSON.parse(
    calls.init?.body ? String(calls.init?.body) : "{}"
  );
  expect(parsedBody.model).toBe("meta.llama3-70b-instruct-v1:0");
  expect(parsedBody.messages[1].content).toBe("Hi there!");
  fetchSpy.mockRestore();
});

it("extracts an expiration claim from jwt payloads", () => {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ exp: 1_700_000_000 }));
  const token = `${header}.${payload}.signature`;

  expect(gloo.describeExpiration(token)).toBe(1_700_000_000);
});

it("returns null when an exp claim is missing", () => {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({}));
  const token = `${header}.${payload}.signature`;

  expect(gloo.describeExpiration(token)).toBeNull();
});

it("raises on failed token responses", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Promise.resolve(
      new Response("boom", { status: 500, statusText: "Server Error" })
    )
  );

  await expect(
    gloo.getAccessToken({ clientId: "id", clientSecret: "secret" })
  ).rejects.toThrow(/status 500/);
});

it("fails the example when an access token is missing", async () => {
  process.env.GLOO_AI_CLIENT_ID = "id";
  process.env.GLOO_AI_CLIENT_SECRET = "secret";
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    mockFetch({ not_access_token: true })
  );

  await expect(gloo.runExample("Hello?")).rejects.toThrow(
    /Access token missing/
  );
});

it("runs the example flow with mocked network calls", async () => {
  process.env.GLOO_AI_CLIENT_ID = "id";
  process.env.GLOO_AI_CLIENT_SECRET = "secret";
  const token = `${base64Url(
    JSON.stringify({ alg: "none", typ: "JWT" })
  )}.${base64Url(JSON.stringify({ exp: 42 }))}.signature`;

  vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(async () => mockFetch({ access_token: token }))
    .mockImplementationOnce(async () =>
      mockFetch({ choices: [{ message: { content: "ok" } }] })
    );
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  await gloo.runExample("Hello?");

  expect(logSpy).toHaveBeenCalledWith("Token expires at (unix seconds): 42");
  expect(logSpy).toHaveBeenCalledWith(
    JSON.stringify({ choices: [{ message: { content: "ok" } }] }, null, 2)
  );
});
