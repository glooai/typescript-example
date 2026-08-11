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
 * query every partition still inside the TTL window and merge, so the
 * Observed view can plot a trend rather than only the last few minutes.
 */
import type {
  CallMetrics,
  ChatMessage,
  LedgerModelRollup,
  LedgerRow,
} from "./types.js";
import type { VisitorTrace } from "./visitor.js";

/** Ledger rows outlive a demo session but not a week. */
export const LEDGER_DAYS = 7;
export const LEDGER_TTL_SECONDS = LEDGER_DAYS * 24 * 60 * 60;
/** Conversations only need to survive a refresh, not a day. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export type LedgerItem = {
  pk: string;
  sk: string;
  entity: "ledger";
  expires_at: number;
  timestamp: string;
} & CallMetrics &
  Partial<VisitorTrace>;

export type SessionItem = {
  pk: string;
  sk: string;
  entity: "session";
  expires_at: number;
  role: ChatMessage["role"];
  content: string;
} & Partial<VisitorTrace> & {
    /** When this visitor last wrote to the conversation. */
    visitor_seen_at?: string;
  };

/** UTC calendar day, the ledger partition key suffix. */
export function ledgerPartition(at: Date): string {
  return `LEDGER#${at.toISOString().slice(0, 10)}`;
}

/**
 * The partitions a read must cover, newest day first. The default is the
 * whole TTL window: those rows are already being stored and paid for, and a
 * two-day read threw away most of what a latency trend has to plot. Each
 * extra day is one more Query against a known partition key, all issued
 * concurrently, so the cost of the wider window is one round trip either way.
 */
export function recentLedgerPartitions(
  now: Date,
  days = LEDGER_DAYS
): string[] {
  return Array.from({ length: Math.max(1, days) }, (_, back) =>
    ledgerPartition(new Date(now.getTime() - back * 24 * 60 * 60 * 1000))
  );
}

export function toLedgerItem(
  metrics: CallMetrics,
  at: Date,
  trace?: VisitorTrace
): LedgerItem {
  const timestamp = at.toISOString();
  return {
    pk: ledgerPartition(at),
    sk: `${timestamp}#${metrics.requestId}`,
    entity: "ledger",
    expires_at: Math.floor(at.getTime() / 1000) + LEDGER_TTL_SECONDS,
    timestamp,
    ...metrics,
    ...trace,
  };
}

/**
 * Drop key and visitor attributes from a stored item before it goes back
 * over the wire. The visitor trace stays server side: an IP hash has a use
 * in CloudWatch and the console, and none in a bundle running on the
 * visitor's own machine. The existing TTL covers the trace too, since it is
 * written on these same rows and expires with them.
 */
export function toLedgerRow(item: LedgerItem): LedgerRow {
  const {
    pk: _pk,
    sk: _sk,
    entity: _entity,
    expires_at: _expiresAt,
    visitor_id: _visitorId,
    visitor_id_source: _visitorIdSource,
    visitor_ip_hash: _visitorIpHash,
    visitor_user_agent: _visitorUserAgent,
    visitor_session_id: _visitorSessionId,
    ...row
  } = item;
  return row;
}

export function sessionKey(sessionId: string): string {
  return `SESSION#${sessionId}`;
}

export function toSessionItems(
  sessionId: string,
  messages: ChatMessage[],
  at: Date,
  trace?: VisitorTrace
): SessionItem[] {
  const expiresAt = Math.floor(at.getTime() / 1000) + SESSION_TTL_SECONDS;
  // The session id is already the partition key, so repeating it inside the
  // trace on every message row buys nothing.
  const { visitor_session_id: _sessionId, ...visitor } = trace ?? {};
  return messages.map((message, index) => ({
    pk: sessionKey(sessionId),
    // Zero-padded so lexicographic sort order matches conversation order.
    sk: `MSG#${String(index).padStart(6, "0")}`,
    entity: "session" as const,
    expires_at: expiresAt,
    role: message.role,
    content: message.content,
    ...(trace ? { ...visitor, visitor_seen_at: at.toISOString() } : {}),
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
