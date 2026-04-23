/**
 * GCS sink for raw probe results + state file.
 *
 * Layout under the canary-results bucket:
 *   runs/YYYY/MM/DD/HH-<runId>.json    -- one file per probe run
 *   state/active-failures.json         -- mutable fail-signature → slack_ts map
 *   state/probe-tier.json              -- lastFullSweepAt + lastTier (adaptive)
 *   state/model-registry/latest.json   -- latest V2 registry snapshot
 */

import { Storage } from "@google-cloud/storage";
import { gzipSync, gunzipSync } from "node:zlib";
import type { ModelRegistryDelta } from "../fixtures/model-registry-delta.js";
import type { ProbeOutcome } from "../probes/types.js";

export type RunArtifact = {
  runId: string;
  startedAt: string;
  completedAt: string;
  outcomes: ProbeOutcome[];
  /**
   * Diff of the live V2 model registry against the previous archived
   * snapshot. Present on runs where we successfully fetched the live
   * registry AND the DB-backed snapshot store was reachable; omitted
   * when the snapshot step was skipped (no DB URL / DB unreachable) so
   * digests can distinguish "no changes" from "diff not available."
   */
  registryDelta?: ModelRegistryDelta;
};

export type ActiveFailures = {
  // signature -> { firstSeenAt, lastSeenAt, slackTs, attempts, lastOutcome, topLevelText?, recoveredAt? }
  [signature: string]: {
    firstSeenAt: string;
    lastSeenAt: string;
    slackTs: string;
    attempts: number;
    lastVerdict: string;
    /**
     * Text of the original top-level failure post. Captured so the
     * recovery path can `chat.update` that post to prepend a
     * `:white_check_mark: *Recovered*` marker — the reaction alone
     * is easy to miss in the channel overview. Optional for
     * backwards-compat with state blobs written before this field
     * was added; when absent we skip the chat.update and still post
     * the threaded recovery reply + add the reaction.
     */
    topLevelText?: string;
    /**
     * When the incident was last closed by a recovery (ISO-8601).
     * An entry with `recoveredAt` set is a "tombstone" — the
     * incident is closed, but we keep it around for a cooldown
     * window so a flapping probe (fail → pass → fail within minutes)
     * gets its next failure threaded onto the original top-level
     * post instead of spawning a fresh one. GC'd past cooldown.
     */
    recoveredAt?: string;
  };
};

/**
 * Persisted state for adaptive-tier decision making. Written by the
 * probe runner at the end of every run; read at the start of the next
 * run to decide whether to execute a cheap "light" pulse probe or the
 * full fan-out sweep.
 *
 * Only tracks the minimum the tier selector needs to reason about the
 * steady-state case — any failure automatically forces Full via the
 * separate `active-failures.json` blob, so we don't duplicate that
 * signal here.
 */
export type ProbeTierState = {
  /** When the most recent Full-tier sweep started (ISO-8601). */
  lastFullSweepAt: string;
  /** Tier chosen on the previous run — informational / debug-only. */
  lastTier: "light" | "full";
};

export interface GcsClient {
  writeJson(objectPath: string, payload: unknown): Promise<void>;
  readJson<T>(objectPath: string): Promise<T | null>;
  list(prefix: string): Promise<string[]>;
  getMetadata(
    objectPath: string
  ): Promise<{ size: number; createdAt: string } | null>;
}

export function createGcsClient(bucket: string): GcsClient {
  const storage = new Storage();
  const ref = storage.bucket(bucket);

  return {
    async writeJson(objectPath: string, payload: unknown): Promise<void> {
      const gz = gzipSync(JSON.stringify(payload));
      await ref.file(objectPath).save(gz, {
        contentType: "application/json",
        metadata: { contentEncoding: "gzip" },
      });
    },
    async readJson<T>(objectPath: string): Promise<T | null> {
      try {
        const [exists] = await ref.file(objectPath).exists();
        if (!exists) return null;
        const [data] = await ref.file(objectPath).download();
        const raw = isGzip(data) ? gunzipSync(data) : data;
        return JSON.parse(raw.toString("utf-8")) as T;
      } catch (error) {
        if ((error as { code?: number }).code === 404) return null;
        throw error;
      }
    },
    async list(prefix: string): Promise<string[]> {
      const [files] = await ref.getFiles({ prefix });
      return files.map((f) => f.name);
    },
    async getMetadata(objectPath: string) {
      const [exists] = await ref.file(objectPath).exists();
      if (!exists) return null;
      const [meta] = await ref.file(objectPath).getMetadata();
      return {
        size: Number(meta.size ?? 0),
        createdAt: String(meta.timeCreated ?? ""),
      };
    },
  };
}

function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** Stable object path for a run's archive: runs/2026/04/20/18-<runId>.json */
export function runArtifactPath(runId: string, startedAt: Date): string {
  const y = startedAt.getUTCFullYear();
  const m = String(startedAt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(startedAt.getUTCDate()).padStart(2, "0");
  const h = String(startedAt.getUTCHours()).padStart(2, "0");
  const safeId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `runs/${y}/${m}/${d}/${h}-${safeId}.json`;
}

export const ACTIVE_FAILURES_PATH = "state/active-failures.json";

/** Probe-tier-state blob — used by the adaptive tier selector. */
export const PROBE_TIER_STATE_PATH = "state/probe-tier.json";
