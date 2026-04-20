/**
 * Exercises createGcsClient — the thin wrapper around @google-cloud/storage.
 * We mock the SDK so tests stay hermetic (no GCS calls, no ADC needed).
 */

import { afterEach, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

type FileMock = {
  save: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  getMetadata: ReturnType<typeof vi.fn>;
};

const fileMocks: Map<string, FileMock> = new Map();
const filesListMock = vi.fn();

vi.mock("@google-cloud/storage", () => {
  class MockStorage {
    bucket() {
      return {
        file: (name: string): FileMock => {
          if (!fileMocks.has(name)) {
            fileMocks.set(name, {
              save: vi.fn(async () => undefined),
              exists: vi.fn(async () => [false]),
              download: vi.fn(async () => [Buffer.from("")]),
              getMetadata: vi.fn(async () => [{ size: 0, timeCreated: "" }]),
            });
          }
          return fileMocks.get(name) as FileMock;
        },
        getFiles: filesListMock,
      };
    }
  }
  return { Storage: MockStorage };
});

afterEach(() => {
  fileMocks.clear();
  filesListMock.mockReset();
});

it("writeJson gzips payloads and sets correct content metadata", async () => {
  const { createGcsClient } = await import("../../src/sinks/gcs.js");
  const client = createGcsClient("test-bucket");

  await client.writeJson("runs/2026/04/20/18-x.json", { hello: "world" });

  const saved = fileMocks.get("runs/2026/04/20/18-x.json");
  expect(saved?.save).toHaveBeenCalledOnce();
  const [body, options] = saved!.save.mock.calls[0] as [
    Buffer,
    Record<string, unknown>,
  ];
  expect(Buffer.isBuffer(body)).toBe(true);
  expect(
    (options.metadata as { contentEncoding: string }).contentEncoding
  ).toBe("gzip");
});

it("readJson returns null when the object doesn't exist", async () => {
  const { createGcsClient } = await import("../../src/sinks/gcs.js");
  const client = createGcsClient("test-bucket");

  const result = await client.readJson<{ hi: string }>("missing.json");
  expect(result).toBeNull();
});

it("readJson transparently gunzips gzip-encoded objects", async () => {
  const { createGcsClient } = await import("../../src/sinks/gcs.js");
  const client = createGcsClient("test-bucket");

  const payload = gzipSync(JSON.stringify({ ok: true }));
  const fileMock: FileMock = {
    save: vi.fn(),
    exists: vi.fn(async () => [true]),
    download: vi.fn(async () => [payload]),
    getMetadata: vi.fn(),
  };
  fileMocks.set("state/active-failures.json", fileMock);

  const result = await client.readJson<{ ok: boolean }>(
    "state/active-failures.json"
  );
  expect(result).toEqual({ ok: true });
});

it("readJson parses plain-JSON objects too (non-gzipped)", async () => {
  const { createGcsClient } = await import("../../src/sinks/gcs.js");
  const client = createGcsClient("test-bucket");

  const fileMock: FileMock = {
    save: vi.fn(),
    exists: vi.fn(async () => [true]),
    download: vi.fn(async () => [Buffer.from('{"ok":1}')]),
    getMetadata: vi.fn(),
  };
  fileMocks.set("plain.json", fileMock);

  expect(await client.readJson<{ ok: number }>("plain.json")).toEqual({
    ok: 1,
  });
});

it("list returns the names of matching files", async () => {
  const { createGcsClient } = await import("../../src/sinks/gcs.js");
  filesListMock.mockResolvedValue([
    [
      { name: "runs/2026/04/20/06-a.json" },
      { name: "runs/2026/04/20/10-b.json" },
    ],
  ]);
  const client = createGcsClient("test-bucket");
  expect(await client.list("runs/")).toEqual([
    "runs/2026/04/20/06-a.json",
    "runs/2026/04/20/10-b.json",
  ]);
});

it("getMetadata returns null for missing objects", async () => {
  const { createGcsClient } = await import("../../src/sinks/gcs.js");
  const client = createGcsClient("test-bucket");
  expect(await client.getMetadata("nope.json")).toBeNull();
});

it("getMetadata returns size + createdAt for existing objects", async () => {
  const fileMock: FileMock = {
    save: vi.fn(),
    exists: vi.fn(async () => [true]),
    download: vi.fn(),
    getMetadata: vi.fn(async () => [
      { size: "1024", timeCreated: "2026-04-20T00:00:00Z" },
    ]),
  };
  fileMocks.set("exists.json", fileMock);
  const { createGcsClient } = await import("../../src/sinks/gcs.js");
  const client = createGcsClient("test-bucket");
  expect(await client.getMetadata("exists.json")).toEqual({
    size: 1024,
    createdAt: "2026-04-20T00:00:00Z",
  });
});
