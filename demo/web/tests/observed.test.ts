import { describe, expect, it } from "vitest";
import {
  bucketRows,
  buildCallSeries,
  chooseGranularity,
  rollingAverage,
  rollingWindow,
  summarise,
} from "../src/observed";
import type { LedgerRow } from "../src/types";

const base: LedgerRow = {
  requestId: "r-0",
  routingMechanism: "auto_routing",
  requested: "auto",
  resolvedModel: "gloo-openai-gpt-5-mini",
  resolvedFamily: "openai",
  routingTier: "balanced",
  routingConfidence: 0.9,
  promptTokens: 20,
  completionTokens: 40,
  cachedTokens: 0,
  latencyMs: 1000,
  ttftMs: 400,
  costUsd: 0.0001,
  status: "ok",
  timestamp: "2026-08-11T12:00:00.000Z",
};

function row(index: number, overrides: Partial<LedgerRow> = {}): LedgerRow {
  return { ...base, requestId: `r-${index}`, ...overrides };
}

/** Minutes after a fixed local noon, so the tests never depend on the runner's zone. */
function at(minutes: number): string {
  const start = new Date(2026, 7, 11, 12, 0, 0, 0);
  return new Date(start.getTime() + minutes * 60_000).toISOString();
}

describe("rollingAverage", () => {
  it("averages over a trailing window", () => {
    expect(rollingAverage([1, 2, 3, 4, 5], 3)).toEqual([1, 1.5, 2, 3, 4]);
  });

  it("averages over whatever history exists rather than dropping the head", () => {
    expect(rollingAverage([10, 20], 5)).toEqual([10, 15]);
  });

  it("is the identity for a window of one", () => {
    expect(rollingAverage([4, 9, 2], 1)).toEqual([4, 9, 2]);
  });

  it("smooths a single outlier instead of following it", () => {
    const smoothed = rollingAverage([100, 100, 100, 1000], 4);
    expect(smoothed[3]).toBe(325);
  });

  it("has nothing to average in an empty series", () => {
    expect(rollingAverage([], 3)).toEqual([]);
  });
});

describe("rollingWindow", () => {
  it("stays wide enough to smooth a very short series", () => {
    expect(rollingWindow(2)).toBe(3);
  });

  it("scales with the series", () => {
    expect(rollingWindow(30)).toBe(6);
  });

  it("stops widening so a long series is not flattened to its mean", () => {
    expect(rollingWindow(500)).toBe(12);
  });
});

describe("buildCallSeries", () => {
  it("orders oldest first and numbers the calls from one", () => {
    const points = buildCallSeries([
      row(1, { timestamp: at(10) }),
      row(0, { timestamp: at(0) }),
    ]);
    expect(points.map((point) => point.seq)).toEqual([1, 2]);
    expect(points[0].timestamp).toBe(Date.parse(at(0)));
  });

  it("leaves failed calls out, since their latency is time to give up", () => {
    const points = buildCallSeries([
      row(0, { timestamp: at(0) }),
      row(1, { timestamp: at(1), status: "error", latencyMs: 30_000 }),
    ]);
    expect(points).toHaveLength(1);
  });

  it("smooths latency rather than tracking every call", () => {
    const rows = [200, 200, 200, 200, 200, 5000].map((latencyMs, index) =>
      row(index, { timestamp: at(index), latencyMs })
    );
    const points = buildCallSeries(rows);
    expect(points[5].latencyMs).toBe(5000);
    expect(points[5].rollingLatencyMs).toBeLessThan(2000);
  });

  it("holds the cost average flat across an unpriced call instead of dipping to zero", () => {
    const points = buildCallSeries([
      row(0, { timestamp: at(0), costUsd: 0.002 }),
      row(1, { timestamp: at(1), costUsd: null }),
    ]);
    expect(points[1].costUsd).toBeNull();
    expect(points[1].rollingCostUsd).toBe(0.002);
  });

  it("reports no cost average until something has been priced", () => {
    const points = buildCallSeries([
      row(0, { timestamp: at(0), costUsd: null }),
    ]);
    expect(points[0].rollingCostUsd).toBeNull();
  });

  it("copes with an empty ledger", () => {
    expect(buildCallSeries([])).toEqual([]);
  });
});

describe("chooseGranularity", () => {
  it("buckets a burst of traffic by hour", () => {
    expect(
      chooseGranularity([
        row(0, { timestamp: at(0) }),
        row(1, { timestamp: at(120) }),
      ])
    ).toBe("hour");
  });

  it("buckets a week of traffic by day", () => {
    expect(
      chooseGranularity([
        row(0, { timestamp: at(0) }),
        row(1, { timestamp: at(60 * 24 * 5) }),
      ])
    ).toBe("day");
  });

  it("defaults to hourly with nothing to measure", () => {
    expect(chooseGranularity([])).toBe("hour");
  });
});

describe("bucketRows", () => {
  it("groups calls into the slot they landed in", () => {
    const buckets = bucketRows(
      [
        row(0, { timestamp: at(0) }),
        row(1, { timestamp: at(20) }),
        row(2, { timestamp: at(70) }),
      ],
      "hour"
    );
    expect(buckets.map((bucket) => bucket.calls)).toEqual([2, 1]);
  });

  it("keeps an empty slot between two busy ones, because a gap is information", () => {
    const buckets = bucketRows(
      [row(0, { timestamp: at(0) }), row(1, { timestamp: at(150) })],
      "hour"
    );
    expect(buckets.map((bucket) => bucket.calls)).toEqual([1, 0, 1]);
  });

  it("counts failures but keeps them out of the average latency", () => {
    const buckets = bucketRows(
      [
        row(0, { timestamp: at(0), latencyMs: 400 }),
        row(1, { timestamp: at(5), latencyMs: 30_000, status: "error" }),
      ],
      "hour"
    );
    expect(buckets[0]).toMatchObject({
      calls: 2,
      errors: 1,
      avgLatencyMs: 400,
    });
  });

  it("totals spend per slot and treats an unpriced call as no spend", () => {
    const buckets = bucketRows(
      [
        row(0, { timestamp: at(0), costUsd: 0.001 }),
        row(1, { timestamp: at(5), costUsd: null }),
      ],
      "hour"
    );
    expect(buckets[0].costUsd).toBeCloseTo(0.001, 10);
  });

  it("has no buckets for an empty ledger", () => {
    expect(bucketRows([])).toEqual([]);
  });
});

describe("summarise", () => {
  it("takes the median so one cold start does not move the headline", () => {
    const rows = [100, 120, 140, 160, 9000].map((latencyMs, index) =>
      row(index, { timestamp: at(index), latencyMs })
    );
    expect(summarise(rows).medianLatencyMs).toBe(140);
  });

  it("averages the middle pair when the count is even", () => {
    const rows = [100, 200, 300, 500].map((latencyMs, index) =>
      row(index, { timestamp: at(index), latencyMs })
    );
    expect(summarise(rows).medianLatencyMs).toBe(250);
  });

  it("counts every call but measures only the successful ones", () => {
    const summary = summarise([
      row(0, { timestamp: at(0) }),
      row(1, { timestamp: at(1), status: "error", costUsd: null }),
    ]);
    expect(summary).toMatchObject({ calls: 2, errors: 1, models: 1 });
    expect(summary.totalCostUsd).toBeCloseTo(0.0001, 10);
  });

  it("returns zeroes rather than NaN for an empty ledger", () => {
    expect(summarise([])).toEqual({
      calls: 0,
      errors: 0,
      models: 0,
      medianLatencyMs: 0,
      totalCostUsd: 0,
      spanMs: 0,
    });
  });
});
