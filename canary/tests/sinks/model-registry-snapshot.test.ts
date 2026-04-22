import { expect, it } from "vitest";
import {
  MODEL_REGISTRY_SNAPSHOT_PATH,
  loadLatestSnapshot,
  saveSnapshot,
  type ModelRegistrySnapshot,
} from "../../src/sinks/model-registry-snapshot.js";
import type { GcsClient } from "../../src/sinks/gcs.js";

function fakeGcs(seed?: Record<string, unknown>): GcsClient & {
  writes: Map<string, unknown>;
} {
  const store = new Map<string, unknown>(Object.entries(seed ?? {}));
  const writes = new Map<string, unknown>();
  return {
    writes,
    async writeJson(path, payload) {
      store.set(path, payload);
      writes.set(path, payload);
    },
    async readJson<T>(path: string): Promise<T | null> {
      return (store.get(path) as T | undefined) ?? null;
    },
    async list() {
      return [];
    },
    async getMetadata() {
      return null;
    },
  };
}

it("loadLatestSnapshot returns null when the blob is missing", async () => {
  const gcs = fakeGcs();
  expect(await loadLatestSnapshot(gcs)).toBeNull();
});

it("loadLatestSnapshot round-trips a persisted snapshot", async () => {
  const snapshot: ModelRegistrySnapshot = {
    capturedAt: "2026-04-22T12:00:00.000Z",
    runId: "canary-probe-xyz",
    modelIds: ["gloo-a", "gloo-b"],
  };
  const gcs = fakeGcs({ [MODEL_REGISTRY_SNAPSHOT_PATH]: snapshot });
  expect(await loadLatestSnapshot(gcs)).toEqual(snapshot);
});

it("saveSnapshot writes to the canonical path and normalizes modelIds to sorted order", async () => {
  const gcs = fakeGcs();
  await saveSnapshot(gcs, {
    capturedAt: "2026-04-22T12:00:00.000Z",
    runId: "canary-probe-xyz",
    modelIds: ["gloo-zzz", "gloo-aaa", "gloo-mmm"],
  });
  const written = gcs.writes.get(
    MODEL_REGISTRY_SNAPSHOT_PATH
  ) as ModelRegistrySnapshot;
  expect(written.modelIds).toEqual(["gloo-aaa", "gloo-mmm", "gloo-zzz"]);
  expect(written.runId).toBe("canary-probe-xyz");
  expect(written.capturedAt).toBe("2026-04-22T12:00:00.000Z");
});
