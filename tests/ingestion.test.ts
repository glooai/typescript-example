import { expect, it, vi, beforeEach, afterEach } from "vitest";
import * as ingestion from "../src/ingestion.js";

type FetchCall = {
  url?: string | URL | Request;
  init?: RequestInit;
};

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

it("loads ingestion credentials from the environment", () => {
  process.env.GLOO_CLIENT_ID = "ingestion-client";
  process.env.GLOO_CLIENT_SECRET = "ingestion-secret";

  const creds = ingestion.loadIngestionCredentials();

  expect(creds).toEqual({
    clientId: "ingestion-client",
    clientSecret: "ingestion-secret",
  });
});

it("throws when ingestion credentials are missing", () => {
  delete process.env.GLOO_CLIENT_ID;
  delete process.env.GLOO_CLIENT_SECRET;

  expect(() => ingestion.loadIngestionCredentials()).toThrow(
    /Missing GLOO_CLIENT_ID environment variable/
  );
});

it("loads publisher ID from the environment", () => {
  process.env.GLOO_PUBLISHER_ID = "pub-123";

  const publisherId = ingestion.loadPublisherId();

  expect(publisherId).toBe("pub-123");
});

it("throws when publisher ID is missing", () => {
  delete process.env.GLOO_PUBLISHER_ID;

  expect(() => ingestion.loadPublisherId()).toThrow(
    /Missing GLOO_PUBLISHER_ID environment variable/
  );
});

it("gets an ingestion token via OAuth2 client credentials flow", async () => {
  const calls: FetchCall = {};
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      calls.url = url;
      calls.init = init;
      return mockFetch({ access_token: "ingestion-token-123" });
    });

  const token = await ingestion.getIngestionToken({
    clientId: "client-id",
    clientSecret: "client-secret",
  });

  expect(token).toBe("ingestion-token-123");
  expect(calls.url).toBe("https://platform.ai.gloo.com/oauth2/token");
  expect(calls.init?.method).toBe("POST");
  expect(calls.init?.headers).toMatchObject({
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: expect.stringContaining("Basic "),
  });
  fetchSpy.mockRestore();
});

it("throws when token response is missing access_token", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    mockFetch({ not_access_token: true })
  );

  await expect(
    ingestion.getIngestionToken({
      clientId: "client-id",
      clientSecret: "client-secret",
    })
  ).rejects.toThrow(/Access token missing/);
});

it("throws when token request fails", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response("unauthorized", {
      status: 401,
      statusText: "Unauthorized",
    });
  });

  await expect(
    ingestion.getIngestionToken({
      clientId: "bad-id",
      clientSecret: "bad-secret",
    })
  ).rejects.toThrow(/status 401/);
});

it("uploads files via multipart form data", async () => {
  const calls: FetchCall = {};
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      calls.url = url;
      calls.init = init;
      return mockFetch({
        success: true,
        message: "Files accepted",
        ingesting: ["file1.txt", "file2.txt"],
        duplicates: [],
      });
    });

  const result = await ingestion.uploadFiles("token-abc", "publisher-xyz", [
    { name: "file1.txt", content: "Hello world" },
    { name: "file2.txt", content: Buffer.from("Binary content") },
  ]);

  expect(result.success).toBe(true);
  expect(result.ingesting).toEqual(["file1.txt", "file2.txt"]);
  expect(result.duplicates).toEqual([]);
  expect(calls.url).toBe("https://api.gloo.ai/ingestion/v2/files");
  expect(calls.init?.method).toBe("POST");
  expect(calls.init?.headers).toMatchObject({
    Authorization: "Bearer token-abc",
  });

  const formData = calls.init?.body as FormData;
  expect(formData).toBeInstanceOf(FormData);
  expect(formData.get("publisher_id")).toBe("publisher-xyz");

  fetchSpy.mockRestore();
});

it("throws when upload fails", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response("server error", {
      status: 500,
      statusText: "Internal Server Error",
    });
  });

  await expect(
    ingestion.uploadFiles("token", "publisher", [
      { name: "test.txt", content: "test" },
    ])
  ).rejects.toThrow(/status 500/);
});

it("handles duplicate files in response", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    mockFetch({
      success: true,
      message: "Some files already ingested",
      ingesting: [],
      duplicates: ["existing.txt"],
    })
  );

  const result = await ingestion.uploadFiles("token", "publisher", [
    { name: "existing.txt", content: "content" },
  ]);

  expect(result.success).toBe(true);
  expect(result.ingesting).toEqual([]);
  expect(result.duplicates).toEqual(["existing.txt"]);
});
