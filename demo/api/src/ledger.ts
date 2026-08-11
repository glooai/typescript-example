/**
 * DynamoDB item shaping and read-side aggregation.
 *
 * Single table, two entity types, both keyed off `pk`/`sk` and both carrying
 * a TTL attribute so demo data expires on its own instead of needing a
 * cleanup job:
 *
 *   1. Ledger  - `pk = LEDGER#<YYYY-MM-DD>`, `sk = <ISO ts>#<requestId>`.
 *      One row per proxied Gloo call, holding the routing decision, the
 *      resolved model, observed tokens, latency, and estimated cost. This
 *      is what makes the demo's cost/latency panel real measurements of
 *      actual traffic rather than registry arithmetic on invented tokens.
 *
 *   2. Session - `pk = SESSION#<sessionId>`, `sk = MSG#<zero-padded seq>`.
 *      One row per chat message, so a demo conversation survives a page
 *      refresh without any server-side session infrastructure.
 *
 * The ledger partition key is the UTC date, not a constant, so write
 * traffic rotates daily instead of hammering one partition forever. Reads
 * query today and yesterday and merge, which is enough for a "recent
 * activity" feed.
 */
import type {
  CallMetrics,
  ChatMessage,
  LedgerModelRollup,
  LedgerRow,
} from "./types.js";

/** Ledger rows outlive a demo session but not a week. */
export const LEDGER_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Conversations only need to survive a refresh, not a day. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export type LedgerItem = {
  pk: string;
  sk: string;
  entity: "ledger";
  expires_at: number;
  timestamp: string;
} & CallMetrics;

export type SessionItem = {
  pk: string;
  sk: string;
  entity: "session";
  expires_at: number;
  role: ChatMessage["role"];
  content: string;
};

/** UTC calendar day, the ledger partition key suffix. */
export function ledgerPartition(at: Date): string {
  return `LEDGER#${at.toISOString().slice(0, 10)}`;
}

/**
 * The partitions a "recent activity" read must cover. Two days is enough
 * that the feed is never empty just because the clock rolled past midnight.
 */
export function recentLedgerPartitions(now: Date): string[] {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return [ledgerPartition(now), ledgerPartition(yesterday)];
}

export function toLedgerItem(metrics: CallMetrics, at: Date): LedgerItem {
  const timestamp = at.toISOString();
  return {
    pk: ledgerPartition(at),
    sk: `${timestamp}#${metrics.requestId}`,
    entity: "ledger",
    expires_at: Math.floor(at.getTime() / 1000) + LEDGER_TTL_SECONDS,
    timestamp,
    ...metrics,
  };
}

export function sessionKey(sessionId: string): string {
  return `SESSION#${sessionId}`;
}

export function toSessionItems(
  sessionId: string,
  messages: ChatMessage[],
  at: Date
): SessionItem[] {
  const expiresAt = Math.floor(at.getTime() / 1000) + SESSION_TTL_SECONDS;
  return messages.map((message, index) => ({
    pk: sessionKey(sessionId),
    // Zero-padded so lexicographic sort order matches conversation order.
    sk: `MSG#${String(index).padStart(6, "0")}`,
    entity: "session" as const,
    expires_at: expiresAt,
    role: message.role,
    content: message.content,
  }));
}

/** Newest first, capped. Callers merge partitions before calling this. */
export function sortRowsNewestFirst(
  rows: LedgerRow[],
  limit: number
): LedgerRow[] {
  return [...rows]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Per-model rollup of observed traffic. Errors are excluded because a
 * failed call's latency says nothing useful about the model, and rows the
 * registry could not price contribute to latency but not to average cost.
 */
export function rollupByModel(rows: LedgerRow[]): LedgerModelRollup[] {
  const grouped = new Map<string, LedgerRow[]>();

  for (const row of rows) {
    if (row.status !== "ok" || !row.resolvedModel) {
      continue;
    }
    const existing = grouped.get(row.resolvedModel);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.resolvedModel, [row]);
    }
  }

  return [...grouped.entries()]
    .map(([model, modelRows]) => {
      const priced = modelRows
        .map((row) => row.costUsd)
        .filter((cost): cost is number => cost !== null);
      return {
        model,
        calls: modelRows.length,
        avgLatencyMs: Math.round(mean(modelRows.map((row) => row.latencyMs))),
        avgCostUsd: Math.round(mean(priced) * 1e8) / 1e8,
        avgCompletionTokens: Math.round(
          mean(modelRows.map((row) => row.completionTokens))
        ),
      };
    })
    .sort((a, b) => b.calls - a.calls);
}
