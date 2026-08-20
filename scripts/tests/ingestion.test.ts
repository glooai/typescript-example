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
  expect(calls.url).toBe("https://platform.ai.gloo.com/ingestion/v2/files");
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
