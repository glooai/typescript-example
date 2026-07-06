import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  buildIngestionProbe,
  buildSentinel,
  INGESTION_SUBMIT_URL,
  itemStatusUrl,
  itemSnippetsUrl,
  ITEMS_DELETE_URL,
  type IngestionFixture,
} from "../../src/probes/ingestion.js";
import type { ProbeContext } from "../../src/probes/types.js";

const CTX: ProbeContext = {
  accessToken: "tok",
  runId: "run-42",
  startedAt: "2026-07-02T00:00:00Z",
};

// No-op sleep so poll/backoff loops execute instantly under test. SLA
// budgets are asserted with tiny slaMs values instead of fake timers.
const instant = async (): Promise<void> => {};

function fixture(overrides: Partial<IngestionFixture> = {}): IngestionFixture {
  return {
    signature: "ingestion/v2/e2e-text-file",
    label: "Ingestion E2E · text file",
    publisherId: "pub-1",
    slaMs: 60_000,
    pollIntervalMs: 1,
    sleep: instant,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const SUBMITTED = jsonResponse(200, {
  success: true,
  message: "File processing started in background.",
  ingesting: ["item-1"],
  duplicates: [],
});

function statusResponse(status: string) {
  return jsonResponse(200, { item_id: "item-1", status });
}

function snippetsResponse(snippets: string[]) {
  return jsonResponse(200, {
    data: snippets.map((snippet, i) => ({ id: `s-${i}`, part: i, snippet })),
    pagination: { total: snippets.length },
  });
}

const DELETED = jsonResponse(200, {
  success: true,
  mode: "hard",
  total_requested: 1,
  total_deleted: 1,
  total_failed: 0,
});

const sentinelSnippet = () => `prefix ${buildSentinel(CTX.runId)} suffix`;

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Happy path ───────────────────────────────────────────────────────

it("passes when submit → COMPLETED → sentinel snippet → cleanup all succeed", async () => {
  fetchMock
    .mockResolvedValueOnce(SUBMITTED)
    .mockResolvedValueOnce(statusResponse("QUEUED"))
    .mockResolvedValueOnce(statusResponse("CHUNKING"))
    .mockResolvedValueOnce(statusResponse("COMPLETED"))
    .mockResolvedValueOnce(snippetsResponse([sentinelSnippet()]))
    .mockResolvedValueOnce(DELETED);

  const out = await buildIngestionProbe(fixture()).run(CTX);

  expect(out.verdict).toBe("PASS");
  expect(out.severity).toBe("GREEN");
  expect(out.apiVersion).toBe("items");
  expect(out.endpoint).toBe(INGESTION_SUBMIT_URL);
  expect(out.details.itemId).toBe("item-1");
  expect(out.details.statusHistory).toEqual([
    expect.objectContaining({ status: "QUEUED" }),
    expect.objectContaining({ status: "CHUNKING" }),
    expect.objectContaining({ status: "COMPLETED" }),
  ]);
  expect(out.details.cleanup).toBe("ok");

  // Submit call: multipart form with publisher_id + our .txt file.
  const [submitUrl, submitInit] = fetchMock.mock.calls[0];
  expect(submitUrl).toBe(INGESTION_SUBMIT_URL);
  expect(submitInit.method).toBe("POST");
  expect(submitInit.headers.Authorization).toBe("Bearer tok");
  const form = submitInit.body as FormData;
  expect(form).toBeInstanceOf(FormData);
  expect(form.get("publisher_id")).toBe("pub-1");
  const file = form.get("files") as File;
  expect(file.name).toMatch(/\.txt$/);
  expect(await file.text()).toContain(buildSentinel(CTX.runId));

  // Poll, snippets, and delete calls hit the expected endpoints.
  expect(fetchMock.mock.calls[1][0]).toBe(itemStatusUrl("item-1"));
  expect(fetchMock.mock.calls[4][0]).toBe(itemSnippetsUrl("item-1"));
  const [deleteUrl, deleteInit] = fetchMock.mock.calls[5];
  expect(deleteUrl).toBe(ITEMS_DELETE_URL);
  expect(deleteInit.method).toBe("DELETE");
  expect(JSON.parse(deleteInit.body)).toEqual({ item_ids: ["item-1"] });
});

// ── Submit stage ─────────────────────────────────────────────────────

it("retries transient 5xx on submit and still passes", async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(502, { message: "bad gateway" }))
    .mockResolvedValueOnce(jsonResponse(503, { message: "unavailable" }))
    .mockResolvedValueOnce(SUBMITTED)
    .mockResolvedValueOnce(statusResponse("COMPLETED"))
    .mockResolvedValueOnce(snippetsResponse([sentinelSnippet()]))
    .mockResolvedValueOnce(DELETED);

  const out = await buildIngestionProbe(fixture()).run(CTX);

  expect(out.verdict).toBe("PASS");
  expect(out.details.submitAttempts).toBe(3);
});

it("fails RED at stage=submit when 5xx persists through all retries", async () => {
  fetchMock.mockResolvedValue(jsonResponse(502, { message: "bad gateway" }));

  const out = await buildIngestionProbe(fixture()).run(CTX);

  expect(out.verdict).toBe("FAIL");
  expect(out.severity).toBe("RED");
  expect(out.details.stage).toBe("submit");
  expect(out.endpoint).toBe(INGESTION_SUBMIT_URL);
  expect(out.httpStatus).toBe(502);
  // 1 initial + 2 retries, and no polling afterwards.
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("maps submit 403 to NOT_ENTITLED / YELLOW (entitlement config signal)", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(403, { code: "INGESTION_NOT_AVAILABLE" })
  );

  const out = await buildIngestionProbe(fixture()).run(CTX);

  expect(out.verdict).toBe("NOT_ENTITLED");
  expect(out.severity).toBe("YELLOW");
  expect(out.details.stage).toBe("submit");
  expect(fetchMock).toHaveBeenCalledTimes(1); // 403 is stable — no retry
});

it("proceeds with the duplicate item id when dedup kicks in", async () => {
  fetchMock
    .mockResolvedValueOnce(
      jsonResponse(200, { success: true, ingesting: [], duplicates: ["dup-9"] })
    )
    .mockResolvedValueOnce(statusResponse("COMPLETED"))
    .mockResolvedValueOnce(snippetsResponse([sentinelSnippet()]))
    .mockResolvedValueOnce(DELETED);

  const out = await buildIngestionProbe(fixture()).run(CTX);

  expect(out.verdict).toBe("PASS");
  expect(out.details.itemId).toBe("dup-9");
  expect(out.details.duplicate).toBe(true);
});

it("classifies a 2xx submit body without item ids as SCHEMA_MISMATCH", async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, { success: true, message: "ok" })
  );

  const out = await buildIngestionProbe(fixture()).run(CTX);

  expect(out.verdict).toBe("SCHEMA_MISMATCH");
  expect(out.severity).toBe("RED");
  expect(out.details.stage).toBe("submit");
});

it("classifies probe-side AbortError on submit as YELLOW / TIMEOUT", async () => {
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  fetchMock.mockRejectedValue(abort);

  const out = await buildIngestionProbe(fixture()).run(CTX);

  expect(out.verdict).toBe("TIMEOUT");
  expect(out.severity).toBe("YELLOW");
});

// ── Processing stage ─────────────────────────────────────────────────

it("fails RED at stage=processing when the item reaches FAILED", async () => {
  fetchMock
    .mockResolvedValueOnce(SUBMITTED)
    .mockResolvedValueOnce(statusResponse("QUEUED"))
    .mockResolvedValueOnce(statusResponse("FAILED"))
    .mockResolvedValueOnce(DELETED); // best-effort cleanup still runs

  const out = await buildIngestionProbe(fixture()).run(CTX);

  expect(out.verdict).toBe("FAIL");
  expect(out.severity).toBe("RED");
  expect(out.details.stage).toBe("processing");
  expect(out.details.lastStatus).toBe("FAILED");
  expect(out.endpoint).toBe(itemStatusUrl("item-1"));
  expect(out.details.cleanup).toBe("ok");
});

it("classifies an item stuck in QUEUED past the SLA as SLA_EXCEEDED / RED", async () => {
  fetchMock
    .mockResolvedValueOnce(SUBMITTED)
    .mockResolvedValue(statusResponse("QUEUED"));
  // Cleanup delete resolves via the same mockResolvedValue — fine, it's
  // best-effort and its body shape isn't asserted here.

  const out = await buildIngestionProbe(fixture({ slaMs: 0 })).run(CTX);

  expect(out.verdict).toBe("SLA_EXCEEDED");
  expect(out.severity).toBe("RED");
  expect(out.details.stage).toBe("processing");
  expect(out.details.lastStatus).toBe("QUEUED");
});

it("tolerates transient poll errors and still passes once COMPLETED", async () => {
  fetchMock
    .mockResolvedValueOnce(SUBMITTED)
    .mockResolvedValueOnce(jsonResponse(500, { message: "blip" }))
    .mockRejectedValueOnce(new Error("socket hang up"))
    .mockResolvedValueOnce(statusResponse("COMPLETED"))
    .mockResolvedValueOnce(snippetsResponse([sentinelSnippet()]))
    .mockResolvedValueOnce(DELETED);

  const out = await buildIngestionProbe(fixture()).run(CTX);

  expect(out.verdict).toBe("PASS");
  expect(out.details.pollErrors).toBe(2);
});

// ── Verify stage ─────────────────────────────────────────────────────

it("fails RED at stage=verify when the item has no snippets", async () => {
  fetchMock
    .mockResolvedValueOnce(SUBMITTED)
    .mockResolvedValueOnce(statusResponse("COMPLETED"))
    .mockResolvedValueOnce(snippetsResponse([]))
    .mockResolvedValueOnce(DELETED);

  const out = await buildIngestionProbe(fixture()).run(CTX);

  expect(out.verdict).toBe("FAIL");
  expect(out.severity).toBe("RED");
  expect(out.details.stage).toBe("verify");
  expect(out.details.reason).toBe("no-snippets");
  expect(out.endpoint).toBe(itemSnippetsUrl("item-1"));
});

it("fails RED at stage=verify when snippets exist but lack the sentinel", async () => {
  fetchMock
    .mockResolvedValueOnce(SUBMITTED)
    .mockResolvedValueOnce(statusResponse("COMPLETED"))
    .mockResolvedValueOnce(snippetsResponse(["unrelated content"]))
    .mockResolvedValueOnce(DELETED);

  const out = await buildIngestionProbe(fixture()).run(CTX);

  expect(out.verdict).toBe("FAIL");
  expect(out.details.stage).toBe("verify");
  expect(out.details.reason).toBe("sentinel-not-found");
});

// ── Cleanup stage ────────────────────────────────────────────────────

it("demotes an otherwise-green run to CLEANUP_FAILED / YELLOW when delete fails", async () => {
  fetchMock
    .mockResolvedValueOnce(SUBMITTED)
    .mockResolvedValueOnce(statusResponse("COMPLETED"))
    .mockResolvedValueOnce(snippetsResponse([sentinelSnippet()]))
    .mockResolvedValueOnce(jsonResponse(500, { message: "boom" }));

  const out = await buildIngestionProbe(fixture()).run(CTX);

  expect(out.verdict).toBe("CLEANUP_FAILED");
  expect(out.severity).toBe("YELLOW");
  expect(out.details.cleanup).toBe("failed");
  expect(out.details.itemId).toBe("item-1");
});
