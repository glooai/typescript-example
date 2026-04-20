/**
 * GCS sink for raw probe results + state file.
 *
 * Layout under the canary-results bucket:
 *   runs/YYYY/MM/DD/HH-<runId>.json    -- one file per probe run
 *   state/active-failures.json         -- mutable fail-signature → slack_ts map
 */

import { Storage } from "@google-cloud/storage";
import { gzipSync, gunzipSync } from "node:zlib";
import type { ProbeOutcome } from "../probes/types.js";

export type RunArtifact = {
  runId: string;
  startedAt: string;
  completedAt: string;
  outcomes: ProbeOutcome[];
};

export type ActiveFailures = {
  // signature -> { firstSeenAt, lastSeenAt, slackTs, attempts, lastOutcome }
  [signature: string]: {
    firstSeenAt: string;
    lastSeenAt: string;
    slackTs: string;
    attempts: number;
    lastVerdict: string;
  };
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
