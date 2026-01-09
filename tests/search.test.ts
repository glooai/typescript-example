import { expect, it, vi, beforeEach, afterEach } from "vitest";
import * as searchModule from "../src/search.js";

type FetchCall = {
  url?: string | URL | Request;
  init?: RequestInit;
};

const originalEnv = { ...process.env };

const mockFetch = (payload: unknown, status = 200): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(payload), {
      status,
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

it("posts search request with correct payload", async () => {
  const calls: FetchCall = {};
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      calls.url = url;
      calls.init = init;
      return mockFetch({
        data: [
          {
            uuid: "123",
            metadata: { certainty: 0.9, score: 0.85 },
            properties: { title: "Test Result" },
          },
        ],
        intent: 1,
      });
    });

  const response = await searchModule.search(
    "token123",
    "leadership",
    "CareyNieuwhof",
    5
  );

  expect(response.data).toHaveLength(1);
  expect(response.data[0].properties.title).toBe("Test Result");
  expect(response.intent).toBe(1);

  expect(calls.url).toBe("https://platform.ai.gloo.com/ai/data/v1/search");
  expect(calls.init?.method).toBe("POST");
  expect(calls.init?.headers).toMatchObject({
    "Content-Type": "application/json",
    Authorization: "Bearer token123",
  });

  const body = JSON.parse(String(calls.init?.body));
  expect(body).toEqual({
    query: "leadership",
    collection: "GlooProd",
    tenant: "CareyNieuwhof",
    certainty: 0.5,
    limit: 5,
  });

  fetchSpy.mockRestore();
});

it("omits limit when not provided", async () => {
  const calls: FetchCall = {};
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      calls.url = url;
      calls.init = init;
      return mockFetch({ data: [], intent: 0 });
    });

  await searchModule.search("token123", "test query", "TestTenant");

  const body = JSON.parse(String(calls.init?.body));
  expect(body).not.toHaveProperty("limit");

  fetchSpy.mockRestore();
});

it("throws on non-200 response", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response("Unauthorized", { status: 401 });
  });

  await expect(
    searchModule.search("bad-token", "query", "tenant")
  ).rejects.toThrow(/status 401/);
});

it("runs the search example with mocked network calls", async () => {
  process.env.GLOO_CLIENT_ID = "id";
  process.env.GLOO_CLIENT_SECRET = "secret";

  vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => mockFetch({ access_token: "token123" }))
    .mockImplementationOnce(() =>
      mockFetch({
        data: [
          {
            uuid: "result-1",
            metadata: { certainty: 0.9, score: 0.8 },
            properties: { title: "Leadership Tips" },
          },
        ],
        intent: 1,
      })
    );

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  await searchModule.runSearchExample("leadership", "CareyNieuwhof");

  expect(logSpy).toHaveBeenCalledWith(
    'Searching for "leadership" in tenant "CareyNieuwhof"...'
  );
  expect(logSpy).toHaveBeenCalledWith("Found 1 results (intent: 1)");
});
