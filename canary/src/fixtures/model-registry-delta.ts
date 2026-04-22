/**
 * Pure diff between two snapshots of the V2 model registry.
 *
 * Kept intentionally separate from the DB client so it can be unit tested
 * in isolation and composed freely — the probe runner loads the previous
 * snapshot, fetches the current list, calls this, and then attaches the
 * result to both the GCS-archived run artifact and the "new snapshot"
 * row it inserts into Postgres.
 */

export type ModelRegistryDelta = {
  /** ISO8601 timestamp of the previous snapshot — null when this is the baseline. */
  previousCapturedAt: string | null;
  /** ISO8601 timestamp of the snapshot we just captured. */
  currentCapturedAt: string;
  /** Model ids present in the current snapshot but not the previous one. */
  added: string[];
  /** Model ids present in the previous snapshot but not the current one. */
  removed: string[];
  /** True when this is the first snapshot ever — `previous` will be null. */
  isFirstSnapshot: boolean;
  /** True when the previous and current model sets are identical. */
  hasChanges: boolean;
};

export type ComputeDeltaInput = {
  previous: { capturedAt: string; modelIds: string[] } | null;
  current: { capturedAt: string; modelIds: string[] };
};

export function computeRegistryDelta(
  input: ComputeDeltaInput
): ModelRegistryDelta {
  const currentSorted = [...input.current.modelIds].sort();

  if (input.previous === null) {
    return {
      previousCapturedAt: null,
      currentCapturedAt: input.current.capturedAt,
      added: currentSorted,
      removed: [],
      isFirstSnapshot: true,
      hasChanges: false,
    };
  }

  const previousSet = new Set(input.previous.modelIds);
  const currentSet = new Set(input.current.modelIds);

  const added: string[] = [];
  for (const id of currentSorted) {
    if (!previousSet.has(id)) added.push(id);
  }
  const removed: string[] = [];
  for (const id of [...input.previous.modelIds].sort()) {
    if (!currentSet.has(id)) removed.push(id);
  }

  return {
    previousCapturedAt: input.previous.capturedAt,
    currentCapturedAt: input.current.capturedAt,
    added,
    removed,
    isFirstSnapshot: false,
    hasChanges: added.length > 0 || removed.length > 0,
  };
}
