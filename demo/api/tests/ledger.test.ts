import { describe, expect, it } from "vitest";
import {
  LEDGER_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  ledgerPartition,
  recentLedgerPartitions,
  rollupByModel,
  sortRowsNewestFirst,
  toLedgerItem,
  toLedgerRow,
  toSessionItems,
} from "../src/ledger.js";
import type { CallMetrics, LedgerRow } from "../src/types.js";
import type { VisitorTrace } from "../src/visitor.js";

const trace: VisitorTrace = {
  visitor_id: "v-0123456789abcdef0123456789abcdef",
  visitor_id_source: "cookie",
  visitor_ip_hash: "8f14e45fceea167a",
  visitor_user_agent: "Mozilla/5.0 (Macintosh)",
  visitor_session_id: "s-abcdef1234",
};

const at = new Date("2026-08-11T10:30:00.000Z");

const metrics: CallMetrics = {
  requestId: "req-1",
  routingMechanism: "auto_routing",
  requested: "auto",
  resolvedModel: "gloo-google-gemini-2.5-flash",
  resolvedFamily: "Google",
  routingTier: "tier_2",
  routingConfidence: 0.55,
  promptTokens: 1129,
  completionTokens: 34,
  cachedTokens: 0,
  latencyMs: 1200,
  ttftMs: 985,
  costUsd: 0.00042,
  status: "ok",
};

function row(overrides: Partial<LedgerRow>): LedgerRow {
  return { ...metrics, timestamp: at.toISOString(), ...overrides };
}

describe("ledger keys", () => {
  it("partitions the ledger by UTC calendar day", () => {
    expect(ledgerPartition(at)).toBe("LEDGER#2026-08-11");
  });

  it("reads today and yesterday so a midnight rollover is not an empty feed", () => {
    expect(recentLedgerPartitions(at)).toEqual([
      "LEDGER#2026-08-11",
      "LEDGER#2026-08-10",
    ]);
  });
});

describe("toLedgerItem", () => {
  it("keys by day and timestamp, and sets a TTL", () => {
    const item = toLedgerItem(metrics, at);

    expect(item.pk).toBe("LEDGER#2026-08-11");
    expect(item.sk).toBe("2026-08-11T10:30:00.000Z#req-1");
    expect(item.entity).toBe("ledger");
    expect(item.expires_at).toBe(
      Math.floor(at.getTime() / 1000) + LEDGER_TTL_SECONDS
    );
    expect(item.resolvedModel).toBe("gloo-google-gemini-2.5-flash");
  });

  it("attaches the visitor trace and lets it expire with the row", () => {
    const item = toLedgerItem(metrics, at, trace);

    expect(item.visitor_id).toBe(trace.visitor_id);
    expect(item.visitor_id_source).toBe("cookie");
    expect(item.visitor_ip_hash).toBe("8f14e45fceea167a");
    expect(item.visitor_user_agent).toBe("Mozilla/5.0 (Macintosh)");
    expect(item.visitor_session_id).toBe("s-abcdef1234");
    expect(item.expires_at).toBe(
      Math.floor(at.getTime() / 1000) + LEDGER_TTL_SECONDS
    );
  });

  it("writes a row with no visitor attributes when there is no trace", () => {
    const item = toLedgerItem(metrics, at);

    expect(item.visitor_id).toBeUndefined();
    expect(item.visitor_ip_hash).toBeUndefined();
  });
});

describe("toLedgerRow", () => {
  it("keeps the visitor trace and the key attributes off the wire", () => {
    const row = toLedgerRow(toLedgerItem(metrics, at, trace));

    expect(row).toEqual({ ...metrics, timestamp: at.toISOString() });
  });
});

describe("toSessionItems", () => {
  const messages = [
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "hi there" },
  ];

  it("zero-pads the sort key so lexical order is conversation order", () => {
    const items = toSessionItems("session-abc12345", messages, at);

    expect(items.map((item) => item.sk)).toEqual(["MSG#000000", "MSG#000001"]);
    expect(items.every((item) => item.pk === "SESSION#session-abc12345")).toBe(
      true
    );
  });

  it("expires conversations sooner than ledger rows", () => {
    const [first] = toSessionItems("session-abc12345", messages, at);

    expect(first.expires_at).toBe(
      Math.floor(at.getTime() / 1000) + SESSION_TTL_SECONDS
    );
    expect(SESSION_TTL_SECONDS).toBeLessThan(LEDGER_TTL_SECONDS);
  });

  it("tags conversation rows with the visitor and when they were seen", () => {
    const items = toSessionItems("session-abc12345", messages, at, trace);

    expect(items[0]?.visitor_id).toBe(trace.visitor_id);
    expect(items[0]?.visitor_ip_hash).toBe("8f14e45fceea167a");
    expect(items[0]?.visitor_seen_at).toBe(at.toISOString());
  });

  it("does not repeat the session id, which is already the partition key", () => {
    const [first] = toSessionItems("session-abc12345", messages, at, trace);

    expect(first?.visitor_session_id).toBeUndefined();
    expect(first?.pk).toBe("SESSION#session-abc12345");
  });

  it("writes plain message rows when there is no trace", () => {
    const [first] = toSessionItems("session-abc12345", messages, at);

    expect(first?.visitor_id).toBeUndefined();
    expect(first?.content).toBe("hello");
  });
});

describe("sortRowsNewestFirst", () => {
  it("merges partitions newest first and applies the cap", () => {
    const rows = [
      row({ requestId: "a", timestamp: "2026-08-10T09:00:00.000Z" }),
      row({ requestId: "b", timestamp: "2026-08-11T09:00:00.000Z" }),
      row({ requestId: "c", timestamp: "2026-08-11T10:00:00.000Z" }),
    ];

    expect(sortRowsNewestFirst(rows, 2).map((r) => r.requestId)).toEqual([
      "c",
      "b",
    ]);
  });
});

describe("rollupByModel", () => {
  it("averages latency, cost, and output tokens per resolved model", () => {
    const rollups = rollupByModel([
      row({ latencyMs: 1000, costUsd: 0.001, completionTokens: 100 }),
      row({ latencyMs: 2000, costUsd: 0.003, completionTokens: 200 }),
      row({
        resolvedModel: "gloo-openai-gpt-5-mini",
        latencyMs: 500,
        costUsd: 0.0005,
        completionTokens: 50,
      }),
    ]);

    expect(rollups[0]).toEqual({
      model: "gloo-google-gemini-2.5-flash",
      calls: 2,
      avgLatencyMs: 1500,
      avgCostUsd: 0.002,
      avgCompletionTokens: 150,
    });
    expect(rollups[1]?.model).toBe("gloo-openai-gpt-5-mini");
  });

  it("excludes failed calls and rows with no resolved model", () => {
    const rollups = rollupByModel([
      row({ status: "error", latencyMs: 60000 }),
      row({ resolvedModel: null }),
      row({ latencyMs: 1000 }),
    ]);

    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.calls).toBe(1);
    expect(rollups[0]?.avgLatencyMs).toBe(1000);
  });

  it("ignores unpriced rows when averaging cost but still counts the call", () => {
    const rollups = rollupByModel([
      row({ costUsd: null, latencyMs: 1000 }),
      row({ costUsd: 0.004, latencyMs: 1000 }),
    ]);

    expect(rollups[0]?.calls).toBe(2);
    expect(rollups[0]?.avgCostUsd).toBe(0.004);
  });
});
