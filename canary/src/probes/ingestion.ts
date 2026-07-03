/**
 * Ingestion E2E probe (GAI-6868) — exercises the Data Engine ingestion
 * pipeline from outside, the way a third-party API customer does:
 *
 *   1. submit   POST  /ingestion/v2/files          multipart, tiny sentinel .txt
 *   2. process  GET   /engine/v2/items/{id}        poll until COMPLETED / FAILED / SLA
 *   3. verify   GET   /engine/v1/files/{id}/snippets   sentinel chunk retrievable
 *   4. cleanup  DELETE /engine/v2/items            hard-delete the canary item
 *
 * The whole journey is reported as ONE ProbeOutcome so the alerting
 * pipeline treats "ingestion" as a single incident stream; the failing
 * stage is attributed via `details.stage` and the outcome's `endpoint`
 * points at the stage that broke.
 *
 * Failure classification:
 *   - submit 5xx / network error  → retried (transient-gateway hardening,
 *     GAI-6848), then FAIL RED
 *   - submit 403                  → NOT_ENTITLED YELLOW (missing
 *     `ingestion_access` entitlement or publisher-org mismatch — a
 *     config signal, not an outage)
 *   - item reaches FAILED         → FAIL RED
 *   - no terminal status in SLA   → SLA_EXCEEDED RED (stalled pipeline)
 *   - COMPLETED but no snippets / sentinel missing → FAIL RED
 *   - everything green but delete failed → CLEANUP_FAILED YELLOW
 */

import { withTimeout } from "@glooai/scripts";
import type {
  Probe,
  ProbeContext,
  ProbeOutcome,
  Severity,
  Verdict,
} from "./types.js";

const BASE = "https://platform.ai.gloo.com";
export const INGESTION_SUBMIT_URL = `${BASE}/ingestion/v2/files`;
export const ITEMS_DELETE_URL = `${BASE}/engine/v2/items`;

export function itemStatusUrl(itemId: string): string {
  return `${BASE}/engine/v2/items/${encodeURIComponent(itemId)}`;
}

export function itemSnippetsUrl(itemId: string): string {
  return `${BASE}/engine/v1/files/${encodeURIComponent(itemId)}/snippets?limit=25`;
}

/**
 * Unique marker embedded in the uploaded file and asserted back out of
 * the snippets endpoint. Keyed on runId so (a) verification can't
 * false-positive on a leftover item from a previous run, and (b) the
 * pipeline's content-dedup never collapses two different runs' files
 * into one item.
 */
export function buildSentinel(runId: string): string {
  return `glooai-canary-sentinel-${runId}`;
}

/** Terminal pipeline statuses (V2StatusEnum in data-engine). */
const STATUS_COMPLETED = "COMPLETED";
const STATUS_FAILED = "FAILED";

const DEFAULT_SLA_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
/** Extra submit attempts after the first (5xx / network errors only). */
const SUBMIT_RETRIES = 2;
const SUBMIT_RETRY_BACKOFF_MS = 2 * 1000;

export type IngestionFixture = {
  signature: string;
  label: string;
  /** Dedicated canary publisher — must belong to the canary client's org. */
  publisherId: string;
  /** End-to-end processing budget before SLA_EXCEEDED (RED). */
  slaMs?: number;
  pollIntervalMs?: number;
  /** Per-HTTP-request budget (each stage call, not the whole journey). */
  requestTimeoutMs?: number;
  /** Injectable for tests — defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });

type HttpResult =
  | { kind: "response"; status: number; rawBody: string }
  | { kind: "abort" }
  | { kind: "network-error"; message: string };

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<HttpResult> {
  const { controller, clearTimer } = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const rawBody = await response.text();
    return { kind: "response", status: response.status, rawBody };
  } catch (error) {
    if ((error as Error).name === "AbortError") return { kind: "abort" };
    return { kind: "network-error", message: (error as Error).message };
  } finally {
    clearTimer();
  }
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

export function buildIngestionProbe(fixture: IngestionFixture): Probe {
  const slaMs = fixture.slaMs ?? DEFAULT_SLA_MS;
  const pollIntervalMs = fixture.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requestTimeoutMs =
    fixture.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const sleep = fixture.sleep ?? realSleep;

  return {
    signature: fixture.signature,
    label: fixture.label,
    async run(ctx: ProbeContext): Promise<ProbeOutcome> {
      const started = Date.now();
      const authHeaders = {
        Accept: "application/json",
        Authorization: `Bearer ${ctx.accessToken}`,
      };
      const sharedDetails: Record<string, unknown> = {
        publisherId: fixture.publisherId,
      };

      const finish = (over: {
        verdict: Verdict;
        severity: Severity;
        endpoint: string;
        httpStatus: number | null;
        responsePreview?: string;
        contentPreview?: string | null;
        details?: Record<string, unknown>;
      }): ProbeOutcome => ({
        signature: fixture.signature,
        label: fixture.label,
        endpoint: over.endpoint,
        apiVersion: "items",
        httpStatus: over.httpStatus,
        verdict: over.verdict,
        severity: over.severity,
        durationMs: Date.now() - started,
        responsePreview: over.responsePreview,
        contentPreview: over.contentPreview ?? null,
        details: { ...sharedDetails, ...(over.details ?? {}) },
        completedAt: Math.floor(Date.now() / 1000),
      });

      // ── Stage 1: submit ─────────────────────────────────────────────
      const sentinel = buildSentinel(ctx.runId);
      const fileContent = [
        `Gloo AI ingestion canary. ${sentinel}.`,
        "This document verifies the Data Engine ingestion pipeline end to end",
        "(submit, chunk, embed, retrieve) and is deleted by the probe on completion.",
      ].join("\n");
      const fileName = `gloo-canary-${ctx.runId.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`;

      let submitAttempts = 0;
      let submitFailure: { httpStatus: number | null; preview: string } | null =
        null;
      let itemId: string | null = null;

      for (let attempt = 1; attempt <= 1 + SUBMIT_RETRIES; attempt++) {
        submitAttempts = attempt;
        // Rebuild the form per attempt — a FormData body is consumed by
        // the fetch that sends it.
        const form = new FormData();
        form.append("publisher_id", fixture.publisherId);
        form.append(
          "files",
          new File([fileContent], fileName, { type: "text/plain" })
        );

        const result = await request(
          INGESTION_SUBMIT_URL,
          { method: "POST", headers: authHeaders, body: form },
          requestTimeoutMs
        );

        if (result.kind === "abort") {
          return finish({
            verdict: "TIMEOUT",
            severity: "YELLOW",
            endpoint: INGESTION_SUBMIT_URL,
            httpStatus: null,
            details: {
              stage: "submit",
              timeoutMs: requestTimeoutMs,
              submitAttempts,
            },
          });
        }

        if (result.kind === "network-error") {
          submitFailure = { httpStatus: null, preview: result.message };
          if (attempt <= SUBMIT_RETRIES)
            await sleep(SUBMIT_RETRY_BACKOFF_MS * attempt);
          continue;
        }

        // 403 = missing `ingestion_access` entitlement or the publisher
        // isn't owned by the canary client's org. Stable config signal —
        // don't retry, don't page.
        if (result.status === 403) {
          return finish({
            verdict: "NOT_ENTITLED",
            severity: "YELLOW",
            endpoint: INGESTION_SUBMIT_URL,
            httpStatus: 403,
            responsePreview: result.rawBody.slice(0, 400),
            details: { stage: "submit", submitAttempts },
          });
        }

        if (result.status >= 200 && result.status < 300) {
          const parsed = parseJson(result.rawBody) as {
            ingesting?: unknown;
            duplicates?: unknown;
          } | null;
          const ingesting = Array.isArray(parsed?.ingesting)
            ? parsed.ingesting
            : [];
          const duplicates = Array.isArray(parsed?.duplicates)
            ? parsed.duplicates
            : [];
          const fresh = typeof ingesting[0] === "string" ? ingesting[0] : null;
          // Content-dedup collapsing our upload onto an existing item is
          // survivable (same pipeline, same verification) — note it and
          // carry on with the duplicate's id.
          const dup = typeof duplicates[0] === "string" ? duplicates[0] : null;
          itemId = fresh ?? dup;
          if (!itemId) {
            return finish({
              verdict: "SCHEMA_MISMATCH",
              severity: "RED",
              endpoint: INGESTION_SUBMIT_URL,
              httpStatus: result.status,
              responsePreview: result.rawBody.slice(0, 400),
              details: {
                stage: "submit",
                reason: "no-item-id-in-response",
                submitAttempts,
              },
            });
          }
          sharedDetails.itemId = itemId;
          sharedDetails.submitAttempts = submitAttempts;
          if (!fresh && dup) sharedDetails.duplicate = true;
          break;
        }

        submitFailure = {
          httpStatus: result.status,
          preview: result.rawBody.slice(0, 400),
        };
        // Only 5xx is plausibly transient; other 4xx shapes are contract
        // failures that a retry can't fix.
        if (result.status < 500) break;
        if (attempt <= SUBMIT_RETRIES)
          await sleep(SUBMIT_RETRY_BACKOFF_MS * attempt);
      }

      if (!itemId) {
        return finish({
          verdict: "FAIL",
          severity: "RED",
          endpoint: INGESTION_SUBMIT_URL,
          httpStatus: submitFailure?.httpStatus ?? null,
          responsePreview: submitFailure?.preview,
          details: { stage: "submit", reason: "submit-failed", submitAttempts },
        });
      }

      // ── Stage 2: poll processing status until terminal or SLA ──────
      const processingStart = Date.now();
      const statusHistory: Array<{ status: string; tMs: number }> = [];
      let lastStatus: string | null = null;
      let pollErrors = 0;
      let processingOutcome: "completed" | "failed" | "sla" = "sla";

      for (;;) {
        const result = await request(
          itemStatusUrl(itemId),
          { method: "GET", headers: authHeaders },
          requestTimeoutMs
        );

        if (
          result.kind === "response" &&
          result.status >= 200 &&
          result.status < 300
        ) {
          const parsed = parseJson(result.rawBody) as {
            status?: unknown;
          } | null;
          const status =
            typeof parsed?.status === "string" ? parsed.status : null;
          if (status) {
            if (status !== lastStatus) {
              statusHistory.push({ status, tMs: Date.now() - processingStart });
            }
            lastStatus = status;
            if (status === STATUS_COMPLETED) {
              processingOutcome = "completed";
              break;
            }
            if (status === STATUS_FAILED) {
              processingOutcome = "failed";
              break;
            }
          } else {
            pollErrors++;
          }
        } else {
          // Transient poll failures (5xx blips, network errors, our own
          // per-request aborts, an eventual-consistency 404 right after
          // submit) don't fail the probe — the SLA budget is the judge.
          pollErrors++;
        }

        if (Date.now() - processingStart >= slaMs) {
          processingOutcome = "sla";
          break;
        }
        await sleep(pollIntervalMs);
      }

      sharedDetails.statusHistory = statusHistory;
      sharedDetails.pollErrors = pollErrors;
      sharedDetails.processingMs = Date.now() - processingStart;

      // ── Stage 4 (early): best-effort cleanup for failure paths ─────
      // Deleting the item is attempted on EVERY path once an id exists —
      // a FAILED or stalled item still occupies the canary publisher.
      const cleanup = async (): Promise<"ok" | "failed"> => {
        const result = await request(
          ITEMS_DELETE_URL,
          {
            method: "DELETE",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ item_ids: [itemId] }),
          },
          requestTimeoutMs
        );
        return result.kind === "response" &&
          result.status >= 200 &&
          result.status < 300
          ? "ok"
          : "failed";
      };

      if (processingOutcome === "failed") {
        sharedDetails.cleanup = await cleanup();
        return finish({
          verdict: "FAIL",
          severity: "RED",
          endpoint: itemStatusUrl(itemId),
          httpStatus: 200,
          details: {
            stage: "processing",
            lastStatus,
            reason: "item-reached-failed",
          },
        });
      }

      if (processingOutcome === "sla") {
        sharedDetails.cleanup = await cleanup();
        return finish({
          verdict: "SLA_EXCEEDED",
          severity: "RED",
          endpoint: itemStatusUrl(itemId),
          httpStatus: null,
          details: { stage: "processing", lastStatus, slaMs },
        });
      }

      // ── Stage 3: verify the sentinel chunk is retrievable ──────────
      const verifyUrl = itemSnippetsUrl(itemId);
      const verifyResult = await request(
        verifyUrl,
        { method: "GET", headers: authHeaders },
        requestTimeoutMs
      );

      if (
        verifyResult.kind !== "response" ||
        verifyResult.status < 200 ||
        verifyResult.status >= 300
      ) {
        sharedDetails.cleanup = await cleanup();
        return finish({
          verdict: "FAIL",
          severity: "RED",
          endpoint: verifyUrl,
          httpStatus:
            verifyResult.kind === "response" ? verifyResult.status : null,
          responsePreview:
            verifyResult.kind === "response"
              ? verifyResult.rawBody.slice(0, 400)
              : verifyResult.kind === "network-error"
                ? verifyResult.message
                : undefined,
          details: { stage: "verify", reason: "snippets-request-failed" },
        });
      }

      const snippetsParsed = parseJson(verifyResult.rawBody) as {
        data?: unknown;
      } | null;
      const snippets = Array.isArray(snippetsParsed?.data)
        ? (snippetsParsed.data as Array<{ snippet?: unknown }>)
        : [];

      if (snippets.length === 0) {
        sharedDetails.cleanup = await cleanup();
        return finish({
          verdict: "FAIL",
          severity: "RED",
          endpoint: verifyUrl,
          httpStatus: verifyResult.status,
          responsePreview: verifyResult.rawBody.slice(0, 400),
          details: { stage: "verify", reason: "no-snippets" },
        });
      }

      const matched = snippets.find(
        (s) => typeof s.snippet === "string" && s.snippet.includes(sentinel)
      );
      if (!matched) {
        sharedDetails.cleanup = await cleanup();
        return finish({
          verdict: "FAIL",
          severity: "RED",
          endpoint: verifyUrl,
          httpStatus: verifyResult.status,
          responsePreview: verifyResult.rawBody.slice(0, 400),
          details: {
            stage: "verify",
            reason: "sentinel-not-found",
            snippetCount: snippets.length,
          },
        });
      }

      // ── Stage 4: cleanup on the green path ──────────────────────────
      const cleanupResult = await cleanup();
      sharedDetails.cleanup = cleanupResult;

      if (cleanupResult === "failed") {
        return finish({
          verdict: "CLEANUP_FAILED",
          severity: "YELLOW",
          endpoint: ITEMS_DELETE_URL,
          httpStatus: null,
          contentPreview: (matched.snippet as string).slice(0, 200),
          details: { stage: "cleanup" },
        });
      }

      return finish({
        verdict: "PASS",
        severity: "GREEN",
        endpoint: INGESTION_SUBMIT_URL,
        httpStatus: 200,
        contentPreview: (matched.snippet as string).slice(0, 200),
        details: {},
      });
    },
  };
}
