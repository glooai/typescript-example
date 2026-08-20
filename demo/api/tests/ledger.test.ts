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
  toSessionIndexItem,
  toSessionItems,
  toSessionSummary,
  sessionPreview,
  sortSessionsNewestFirst,
  visitorKey,
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

  it("reads back across the whole retention window, newest day first", () => {
    expect(recentLedgerPartitions(at)).toEqual([
      "LEDGER#2026-08-11",
      "LEDGER#2026-08-10",
      "LEDGER#2026-08-09",
      "LEDGER#2026-08-08",
      "LEDGER#2026-08-07",
      "LEDGER#2026-08-06",
      "LEDGER#2026-08-05",
    ]);
  });

  it("crosses a month boundary rather than decrementing the day number", () => {
    expect(
      recentLedgerPartitions(new Date("2026-09-02T00:30:00.000Z"), 3)
    ).toEqual(["LEDGER#2026-09-02", "LEDGER#2026-09-01", "LEDGER#2026-08-31"]);
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

describe("sessionPreview", () => {
  it("labels a conversation with its opening question, on one line", () => {
    expect(
      sessionPreview([
        { role: "user", content: "  How does\n  Psalm 23 read?  " },
        { role: "assistant", content: "It reads..." },
      ])
    ).toBe("How does Psalm 23 read?");
  });

  it("ignores a leading assistant turn and reads the first user one", () => {
    expect(
      sessionPreview([
        { role: "assistant", content: "Ask something to get started." },
        { role: "user", content: "Grace and mercy?" },
      ])
    ).toBe("Grace and mercy?");
  });

  it("truncates a long prompt to a list label", () => {
    const preview = sessionPreview([
      { role: "user", content: "a".repeat(400) },
    ]);

    expect(preview.endsWith("...")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(123);
  });

  it("is empty for a conversation with no user text yet", () => {
    expect(sessionPreview([])).toBe("");
  });
});

describe("toSessionIndexItem", () => {
  const messages = [
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "hi there" },
  ];

  it("keys one summary row per conversation under the visitor", () => {
    const item = toSessionIndexItem(
      trace.visitor_id,
      "session-abc12345",
      messages,
      at
    );

    expect(item.pk).toBe(visitorKey(trace.visitor_id));
    expect(item.sk).toBe("SESSION#session-abc12345");
    expect(item.entity).toBe("session_index");
    expect(item.session_id).toBe("session-abc12345");
    expect(item.last_message_at).toBe(at.toISOString());
    expect(item.preview).toBe("hello");
  });

  it("overwrites its own row on a later turn instead of adding one", () => {
    const later = new Date(at.getTime() + 60_000);
    const first = toSessionIndexItem(
      trace.visitor_id,
      "session-abc12345",
      messages,
      at
    );
    const second = toSessionIndexItem(
      trace.visitor_id,
      "session-abc12345",
      [...messages, { role: "user" as const, content: "and again" }],
      later
    );

    expect(second.pk).toBe(first.pk);
    expect(second.sk).toBe(first.sk);
    expect(second.last_message_at).toBe(later.toISOString());
  });

  it("expires with the transcript it describes", () => {
    const item = toSessionIndexItem(
      trace.visitor_id,
      "session-abc12345",
      messages,
      at
    );

    expect(item.expires_at).toBe(
      Math.floor(at.getTime() / 1000) + SESSION_TTL_SECONDS
    );
  });
});

describe("toSessionSummary", () => {
  it("reads a stored row back", () => {
    const item = toSessionIndexItem(
      trace.visitor_id,
      "session-abc12345",
      [{ role: "user", content: "hello" }],
      at
    );

    expect(toSessionSummary(item)).toEqual({
      id: "session-abc12345",
      lastMessageAt: at.toISOString(),
      preview: "hello",
    });
  });

  it("keeps an unlabelled conversation rather than dropping it", () => {
    expect(
      toSessionSummary({
        session_id: "session-abc12345",
        last_message_at: at.toISOString(),
      })
    ).toEqual({
      id: "session-abc12345",
      lastMessageAt: at.toISOString(),
      preview: "",
    });
  });

  it("drops rows that could not be opened or ordered", () => {
    expect(toSessionSummary(null)).toBeNull();
    expect(toSessionSummary("SESSION#x")).toBeNull();
    expect(toSessionSummary({ last_message_at: at.toISOString() })).toBeNull();
    expect(toSessionSummary({ session_id: "s-1" })).toBeNull();
    expect(
      toSessionSummary({ session_id: "s-1", last_message_at: "not a date" })
    ).toBeNull();
    expect(
      toSessionSummary({ session_id: 42, last_message_at: at.toISOString() })
    ).toBeNull();
  });
});

describe("sortSessionsNewestFirst", () => {
  it("orders by last message and applies the cap", () => {
    const sessions = [
      { id: "a", lastMessageAt: "2026-08-11T09:00:00.000Z", preview: "a" },
      { id: "b", lastMessageAt: "2026-08-11T11:00:00.000Z", preview: "b" },
      { id: "c", lastMessageAt: "2026-08-11T10:00:00.000Z", preview: "c" },
    ];

    expect(sortSessionsNewestFirst(sessions, 2).map((s) => s.id)).toEqual([
      "b",
      "c",
    ]);
    expect(sessions[0]?.id).toBe("a");
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
