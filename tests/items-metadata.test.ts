import { expect, it, vi, beforeEach, afterEach, describe } from "vitest";
import { EventEmitter } from "node:events";
import * as itemsMetadataModule from "../src/items-metadata.js";
import type { ItemMetadata } from "../src/items-metadata.js";

// Mock stream class
class MockWriteStream extends EventEmitter {
  write = vi.fn(() => true);
  end = vi.fn((callback?: () => void) => {
    if (callback) callback();
    return this;
  });
}

let mockStream: MockWriteStream;

vi.mock("node:fs", () => ({
  createWriteStream: vi.fn(() => mockStream),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/auth.js", () => ({
  loadCredentials: vi.fn(() => ({ clientId: "id", clientSecret: "secret" })),
  getAccessToken: vi.fn(),
}));

vi.mock("../src/items.js", () => ({
  getItems: vi.fn(),
  loadPublisherId: vi.fn(() => "publisher-123"),
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
  mockStream = new MockWriteStream();
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

const sampleMetadata: ItemMetadata = {
  item_id: "item-123",
  status: "active",
  updated_at: "2024-01-01T00:00:00Z",
  etag: "abc123",
  restore_by: "",
  item_title: "Test Item",
  item_subtitle: "Subtitle",
  filename: "test.pdf",
  publication_date: "2024-01-01",
  type: "document",
  item_image: "",
  item_url: "",
  item_file: "",
  item_summary: "Summary",
  item_number: "1",
  item_extra: "",
  isbn: "",
  author: ["Author 1"],
  item_tags: ["tag1"],
  evergreen: false,
  visible_in_search: true,
  visible_in_chat: true,
  collection_memberships: [],
};

describe("getItemMetadata", () => {
  it("returns metadata when API returns 200", async () => {
    const calls: FetchCall = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.url = url;
      calls.init = init;
      return mockFetch(sampleMetadata);
    });

    const result = await itemsMetadataModule.getItemMetadata(
      "token123",
      "item-123"
    );

    expect(result).toEqual(sampleMetadata);
    expect(calls.url).toBe(
      "https://platform.ai.gloo.com/engine/v2/items/item-123"
    );
    expect(calls.init?.method).toBe("GET");
    expect(calls.init?.headers).toMatchObject({
      Authorization: "Bearer token123",
    });
  });

  it("returns null when API returns 404", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("Not Found", { status: 404 });
    });

    const result = await itemsMetadataModule.getItemMetadata(
      "token123",
      "missing-item"
    );

    expect(result).toBeNull();
  });

  it("throws error on non-200/404 responses", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("Internal Server Error", { status: 500 });
    });

    await expect(
      itemsMetadataModule.getItemMetadata("token123", "item-123")
    ).rejects.toThrow(/status 500/);
  });
});

describe("fetchAllMetadata", () => {
  it("yields metadata for each item with index and total", async () => {
    const { getItems } = await import("../src/items.js");
    vi.mocked(getItems).mockResolvedValue([
      {
        item_id: "item-1",
        status: "active",
        item_title: "Item 1",
        filename: "1.pdf",
      },
      {
        item_id: "item-2",
        status: "active",
        item_title: "Item 2",
        filename: "2.pdf",
      },
    ]);

    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() =>
        mockFetch({
          ...sampleMetadata,
          item_id: "item-1",
          item_title: "Item 1",
        })
      )
      .mockImplementationOnce(() =>
        mockFetch({
          ...sampleMetadata,
          item_id: "item-2",
          item_title: "Item 2",
        })
      );

    const results: Array<{
      metadata: ItemMetadata;
      index: number;
      total: number;
    }> = [];
    for await (const item of itemsMetadataModule.fetchAllMetadata(
      "token123",
      "publisher-123"
    )) {
      results.push(item);
    }

    expect(results).toHaveLength(2);
    expect(results[0].index).toBe(0);
    expect(results[0].total).toBe(2);
    expect(results[0].metadata.item_id).toBe("item-1");
    expect(results[1].index).toBe(1);
    expect(results[1].total).toBe(2);
    expect(results[1].metadata.item_id).toBe("item-2");
  });

  it("skips items that return null and logs warning", async () => {
    const { getItems } = await import("../src/items.js");
    vi.mocked(getItems).mockResolvedValue([
      {
        item_id: "item-1",
        status: "active",
        item_title: "Item 1",
        filename: "1.pdf",
      },
      {
        item_id: "deleted-item",
        status: "deleted",
        item_title: "Deleted",
        filename: "d.pdf",
      },
    ]);

    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() =>
        mockFetch({ ...sampleMetadata, item_id: "item-1" })
      )
      .mockImplementationOnce(() =>
        Promise.resolve(new Response("Not Found", { status: 404 }))
      );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const results: Array<{
      metadata: ItemMetadata;
      index: number;
      total: number;
    }> = [];
    for await (const item of itemsMetadataModule.fetchAllMetadata(
      "token123",
      "publisher-123"
    )) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0].metadata.item_id).toBe("item-1");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("deleted-item not found")
    );
  });

  it("handles empty items list", async () => {
    const { getItems } = await import("../src/items.js");
    vi.mocked(getItems).mockResolvedValue([]);

    const results: Array<{
      metadata: ItemMetadata;
      index: number;
      total: number;
    }> = [];
    for await (const item of itemsMetadataModule.fetchAllMetadata(
      "token123",
      "publisher-123"
    )) {
      results.push(item);
    }

    expect(results).toHaveLength(0);
  });
});

describe("streamMetadataToFile", () => {
  it("writes JSON array to file stream", async () => {
    async function* singleItemGenerator() {
      yield { metadata: sampleMetadata, index: 0, total: 1 };
    }

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const count = await itemsMetadataModule.streamMetadataToFile(
      singleItemGenerator(),
      "/output/test.json"
    );

    expect(count).toBe(1);
    expect(mockStream.write).toHaveBeenCalledWith("[\n");
    expect(mockStream.write).toHaveBeenCalledWith(
      expect.stringContaining('"item_id": "item-123"')
    );
    expect(mockStream.write).toHaveBeenCalledWith("\n]\n");
    expect(mockStream.end).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("[1/1] Test Item");
  });

  it("handles multiple items with correct comma formatting", async () => {
    async function* multiItemGenerator() {
      yield {
        metadata: { ...sampleMetadata, item_id: "item-1", item_title: "First" },
        index: 0,
        total: 2,
      };
      yield {
        metadata: {
          ...sampleMetadata,
          item_id: "item-2",
          item_title: "Second",
        },
        index: 1,
        total: 2,
      };
    }

    vi.spyOn(console, "log").mockImplementation(() => {});

    const count = await itemsMetadataModule.streamMetadataToFile(
      multiItemGenerator(),
      "/output/test.json"
    );

    expect(count).toBe(2);

    // First item starts with "  " (no comma)
    const writeCalls = mockStream.write.mock.calls;
    const firstItemCall = writeCalls.find(
      (call) => typeof call[0] === "string" && call[0].includes('"item-1"')
    );
    expect(firstItemCall?.[0]).toMatch(/^  /);

    // Second item starts with ",\n  " (with comma)
    const secondItemCall = writeCalls.find(
      (call) => typeof call[0] === "string" && call[0].includes('"item-2"')
    );
    expect(secondItemCall?.[0]).toMatch(/^,\n  /);
  });

  it("returns count of written items", async () => {
    async function* emptyGenerator() {
      // yields nothing
    }

    vi.spyOn(console, "log").mockImplementation(() => {});

    const count = await itemsMetadataModule.streamMetadataToFile(
      emptyGenerator(),
      "/output/test.json"
    );

    expect(count).toBe(0);
  });
});

describe("runItemsMetadataExample", () => {
  it("runs full flow with mocked dependencies", async () => {
    const { getAccessToken } = await import("../src/auth.js");
    const { getItems } = await import("../src/items.js");

    vi.mocked(getAccessToken).mockResolvedValue({ access_token: "token123" });
    vi.mocked(getItems).mockResolvedValue([
      {
        item_id: "item-1",
        status: "active",
        item_title: "Test Item",
        filename: "test.pdf",
      },
    ]);

    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      mockFetch(sampleMetadata)
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await itemsMetadataModule.runItemsMetadataExample();

    expect(logSpy).toHaveBeenCalledWith(
      'Fetching items for publisher "publisher-123"...'
    );
    expect(logSpy).toHaveBeenCalledWith("Fetching metadata...");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Saved 1 metadata records")
    );
  });

  it("throws when access token is missing", async () => {
    const { getAccessToken } = await import("../src/auth.js");
    vi.mocked(getAccessToken).mockResolvedValue({});

    await expect(itemsMetadataModule.runItemsMetadataExample()).rejects.toThrow(
      "Access token missing from token response."
    );
  });
});
