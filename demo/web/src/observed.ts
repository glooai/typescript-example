/**
 * Read-side aggregation for the Observed view.
 *
 * `GET /api/ledger` returns raw rows plus a per-model rollup, and the rows
 * are global: the ledger partition key is the UTC calendar day, with no
 * visitor or session in the key and no filter on the read, so every visitor
 * sees the same measured traffic. Everything here turns that one payload
 * into chart-shaped series.
 *
 * All of it is pure and locale-free. Bucket boundaries come back as epoch
 * milliseconds rather than formatted strings so the maths is testable and
 * the visitor's own locale decides how a label reads.
 */
import type { LedgerRow } from "./types";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Below this span an hourly bucket still has calls in it; above it, hourly
 * buckets are mostly empty and a daily bucket is the honest summary.
 */
const HOURLY_SPAN_LIMIT_MS = 36 * HOUR_MS;

export type CallPoint = {
  /** 1-based position in the series, oldest first. */
  seq: number;
  timestamp: number;
  latencyMs: number;
  /** Trailing mean of the last `window` calls, this one included. */
  rollingLatencyMs: number;
  costUsd: number | null;
  rollingCostUsd: number | null;
  model: string | null;
};

export type BucketGranularity = "hour" | "day";

export type TrendBucket = {
  /** Bucket start, epoch ms, aligned to the local hour or local midnight. */
  start: number;
  calls: number;
  errors: number;
  /** Mean over the successful calls in the bucket; 0 when there are none. */
  avgLatencyMs: number;
  /** Total priced spend in the bucket. */
  costUsd: number;
};

export type LedgerSummary = {
  calls: number;
  errors: number;
  models: number;
  /** Median rather than mean: one cold start should not move the headline. */
  medianLatencyMs: number;
  totalCostUsd: number;
  spanMs: number;
};

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Trailing simple moving average. The first points average over whatever
 * history exists rather than being dropped, so a series of three calls still
 * draws a line from its first point instead of starting two points in.
 */
export function rollingAverage(values: number[], window: number): number[] {
  const size = Math.max(1, Math.floor(window));
  return values.map((_, index) =>
    mean(values.slice(Math.max(0, index - size + 1), index + 1))
  );
}

/**
 * Smooth over roughly a fifth of the series, bounded so the line neither
 * tracks every spike on a long series nor flattens a short one into its own
 * overall mean.
 */
export function rollingWindow(count: number): number {
  return Math.min(12, Math.max(3, Math.round(count / 5)));
}

/** Successful calls only, oldest first. A failure's latency is time to give up. */
function successes(rows: LedgerRow[]): LedgerRow[] {
  return rows
    .filter((row) => row.status === "ok")
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function buildCallSeries(rows: LedgerRow[]): CallPoint[] {
  const ordered = successes(rows);
  if (ordered.length === 0) {
    return [];
  }

  const window = rollingWindow(ordered.length);
  const rollingLatency = rollingAverage(
    ordered.map((row) => row.latencyMs),
    window
  );

  // Unpriced models contribute latency but must not be averaged in as $0,
  // so the cost line is a rolling average over the priced calls only and is
  // held flat across a gap rather than dipping through it.
  const priced: number[] = [];
  const rollingCost = ordered.map((row) => {
    if (row.costUsd === null) {
      return priced.length === 0
        ? null
        : mean(priced.slice(Math.max(0, priced.length - window)));
    }
    priced.push(row.costUsd);
    return mean(priced.slice(Math.max(0, priced.length - window)));
  });

  return ordered.map((row, index) => ({
    seq: index + 1,
    timestamp: Date.parse(row.timestamp),
    latencyMs: row.latencyMs,
    rollingLatencyMs: Math.round(rollingLatency[index]),
    costUsd: row.costUsd,
    rollingCostUsd: rollingCost[index],
    model: row.resolvedModel,
  }));
}

/** Local hour or local midnight containing `at`. */
function bucketStart(at: number, granularity: BucketGranularity): number {
  const date = new Date(at);
  date.setMinutes(0, 0, 0);
  if (granularity === "day") {
    date.setHours(0);
  }
  return date.getTime();
}

function nextBucket(start: number, granularity: BucketGranularity): number {
  const date = new Date(start);
  // Stepping through the Date API rather than adding a fixed offset keeps
  // the buckets aligned across a daylight-saving change.
  if (granularity === "day") {
    date.setDate(date.getDate() + 1);
  } else {
    date.setHours(date.getHours() + 1);
  }
  return date.getTime();
}

export function chooseGranularity(rows: LedgerRow[]): BucketGranularity {
  if (rows.length === 0) {
    return "hour";
  }
  const times = rows.map((row) => Date.parse(row.timestamp));
  const span = Math.max(...times) - Math.min(...times);
  return span > HOURLY_SPAN_LIMIT_MS ? "day" : "hour";
}

/**
 * Bucket every row, successes and failures alike, into equal slots. Empty
 * slots between the first and last call are kept: a gap in the traffic is
 * information, and dropping it would draw a busy hour next to a quiet one
 * as though they were adjacent.
 */
export function bucketRows(
  rows: LedgerRow[],
  granularity: BucketGranularity = chooseGranularity(rows)
): TrendBucket[] {
  if (rows.length === 0) {
    return [];
  }

  const grouped = new Map<number, LedgerRow[]>();
  for (const row of rows) {
    const key = bucketStart(Date.parse(row.timestamp), granularity);
    const existing = grouped.get(key);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }

  const keys = [...grouped.keys()].sort((a, b) => a - b);
  const buckets: TrendBucket[] = [];
  const last = keys[keys.length - 1];

  for (
    let start = keys[0];
    start <= last;
    start = nextBucket(start, granularity)
  ) {
    const inBucket = grouped.get(start) ?? [];
    const ok = inBucket.filter((row) => row.status === "ok");
    buckets.push({
      start,
      calls: inBucket.length,
      errors: inBucket.length - ok.length,
      avgLatencyMs: Math.round(mean(ok.map((row) => row.latencyMs))),
      costUsd: ok.reduce((total, row) => total + (row.costUsd ?? 0), 0),
    });
  }

  return buckets;
}

/**
 * Headline numbers. Errors are counted but kept out of the latency and cost
 * figures, matching how the server's per-model rollup treats them.
 */
export function summarise(rows: LedgerRow[]): LedgerSummary {
  const ok = rows.filter((row) => row.status === "ok");
  const latencies = ok.map((row) => row.latencyMs).sort((a, b) => a - b);
  const middle = Math.floor(latencies.length / 2);

  const times = rows.map((row) => Date.parse(row.timestamp));

  return {
    calls: rows.length,
    errors: rows.length - ok.length,
    models: new Set(ok.map((row) => row.resolvedModel).filter(Boolean)).size,
    medianLatencyMs:
      latencies.length === 0
        ? 0
        : latencies.length % 2 === 1
          ? latencies[middle]
          : Math.round((latencies[middle - 1] + latencies[middle]) / 2),
    totalCostUsd: ok.reduce((total, row) => total + (row.costUsd ?? 0), 0),
    spanMs: times.length === 0 ? 0 : Math.max(...times) - Math.min(...times),
  };
}
