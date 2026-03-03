import { expect, it, vi, beforeEach, afterEach } from "vitest";
import * as itemsModule from "../src/items.js";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

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

it("sends GET request with correct URL and authorization", async () => {
  const calls: FetchCall = {};
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      calls.url = url;
      calls.init = init;
      return mockFetch([
        {
          item_id: "abc-123",
          status: "active",
          item_title: "Test Item",
          filename: "test.txt",
        },
      ]);
    });

  const response = await itemsModule.getItems("token123", "publisher-456");

  expect(response).toHaveLength(1);
  expect(response[0].item_id).toBe("abc-123");
  expect(response[0].item_title).toBe("Test Item");

  expect(calls.url).toBe(
    "https://platform.ai.gloo.com/engine/v2/publisher/publisher-456/items"
  );
  expect(calls.init?.method).toBe("GET");
  expect(calls.init?.headers).toMatchObject({
    Authorization: "Bearer token123",
  });

  fetchSpy.mockRestore();
});

it("returns empty array when no items exist", async () => {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => mockFetch([]));

  const response = await itemsModule.getItems("token123", "publisher-456");

  expect(response).toHaveLength(0);

  fetchSpy.mockRestore();
});

it("throws on non-200 response", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response("Unauthorized", { status: 401 });
  });

  await expect(
    itemsModule.getItems("bad-token", "publisher-456")
  ).rejects.toThrow(/status 401/);
});

it("throws on 422 validation error", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response(
      JSON.stringify({
        detail: [
          { loc: ["publisher_id"], msg: "Invalid", type: "value_error" },
        ],
      }),
      { status: 422 }
    );
  });

  await expect(
    itemsModule.getItems("token123", "invalid-publisher")
  ).rejects.toThrow(/status 422/);
});

it("loads publisher ID from environment", () => {
  process.env.GLOO_PUBLISHER_ID = "test-publisher-id";

  const publisherId = itemsModule.loadPublisherId();

  expect(publisherId).toBe("test-publisher-id");
});

it("throws when publisher ID is missing", () => {
  delete process.env.GLOO_PUBLISHER_ID;

  expect(() => itemsModule.loadPublisherId()).toThrow(
    /Missing GLOO_PUBLISHER_ID environment variable/
  );
});

it("runs the items example with mocked network calls", async () => {
  process.env.GLOO_CLIENT_ID = "id";
  process.env.GLOO_CLIENT_SECRET = "secret";
  process.env.GLOO_PUBLISHER_ID = "publisher-123";

  vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => mockFetch({ access_token: "token123" }))
    .mockImplementationOnce(() =>
      mockFetch([
        {
          item_id: "item-1",
          status: "active",
          item_title: "First Item",
          filename: "first.txt",
        },
        {
          item_id: "item-2",
          status: "pending",
          item_title: "Second Item",
          filename: "second.txt",
        },
      ])
    );

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  await itemsModule.runItemsExample();

  expect(logSpy).toHaveBeenCalledWith(
    'Fetching items for publisher "publisher-123"...'
  );
  expect(logSpy).toHaveBeenCalledWith("Found 2 item(s)");
});
