/**
 * GCS-backed "most recent model list" blob.
 *
 * Mirrors the existing `state/active-failures.json` pattern — one small
 * JSON file in the canary results bucket, overwritten on every probe run.
 * That's the simplest thing that could possibly work for the feature:
 * "tell me what changed in `/platform/v2/models` since last time." We
 * don't need a row per snapshot, we only need diff-against-latest.
 *
 * Layout:
 *   state/model-registry-snapshot.json   {
 *     capturedAt: ISO8601,
 *     runId: string,
 *     modelIds: string[],        (sorted, for easy eyeballing)
 *     families: string[]         (sorted, distinct family names)
 *   }
 *
 * `families` was added alongside the dynamic-routing-fixture change
 * so the digest can filter retired family signatures the same way
 * it already filters retired model signatures. Older snapshots
 * without `families` are still readable — the digest falls open
 * (null filter) in that case until the next probe run rewrites the
 * blob.
 *
 * If we ever want history ("give me every registry diff over 30 days")
 * we can tack on an append-only `state/model-registry-history.jsonl`
 * sibling later without touching this file — but the immediate ask
 * ("surface adds/removes in the digest") is served entirely by the
 * "latest only" blob.
 */

import type { GcsClient } from "./gcs.js";

export const MODEL_REGISTRY_SNAPSHOT_PATH =
  "state/model-registry-snapshot.json";

export type ModelRegistrySnapshot = {
  capturedAt: string;
  runId: string;
  modelIds: string[];
  /**
   * Distinct `family` values observed in the registry at capture
   * time. Optional for backwards-compat with snapshots written
   * before the field was introduced — reader code must tolerate
   * `undefined`.
   */
  families?: string[];
};

export async function loadLatestSnapshot(
  gcs: GcsClient
): Promise<ModelRegistrySnapshot | null> {
  return gcs.readJson<ModelRegistrySnapshot>(MODEL_REGISTRY_SNAPSHOT_PATH);
}

export async function saveSnapshot(
  gcs: GcsClient,
  snapshot: ModelRegistrySnapshot
): Promise<void> {
  // Normalize: store ids + families sorted so the blob is diff-friendly
  // on inspection.
  const normalized: ModelRegistrySnapshot = {
    capturedAt: snapshot.capturedAt,
    runId: snapshot.runId,
    modelIds: [...snapshot.modelIds].sort(),
    ...(snapshot.families ? { families: [...snapshot.families].sort() } : {}),
  };
  await gcs.writeJson(MODEL_REGISTRY_SNAPSHOT_PATH, normalized);
}
