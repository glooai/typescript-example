import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { fetchLedger } from "../api";
import { seriesColor, useChartPalette, type ChartPalette } from "../chartTheme";
import {
  formatCost,
  formatLatency,
  formatTokens,
  shortModelName,
} from "../format";
import {
  bucketRows,
  buildCallSeries,
  chooseGranularity,
  rollingWindow,
  summarise,
  type BucketGranularity,
  type CallPoint,
  type TrendBucket,
} from "../observed";
import type { LedgerModelRollup, LedgerRow } from "../types";
import { ErrorNote, Panel } from "./ui";

/** The compact log is a sample, not a second copy of the ledger. */
const ACTIVITY_ROWS = 8;

/** Bubble area range for the model scatter, in square pixels. */
const BUBBLE_RANGE: [number, number] = [90, 900];

/** One bar filling the whole plot area reads as a background, not a bar. */
const MAX_BAR_WIDTH = 56;

const DAY_MS = 24 * 60 * 60 * 1000;

function timeLabel(at: number | undefined): string {
  if (at === undefined) {
    return "";
  }
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateLabel(at: number): string {
  return new Date(at).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function bucketLabel(at: number, granularity: BucketGranularity): string {
  return granularity === "day" ? dateLabel(at) : timeLabel(at);
}

/**
 * Axis ticks for money. A demo call lands well under a cent, so a fixed two
 * decimals would label every tick `$0.00` and a fixed three would print two
 * neighbouring ticks identically. Scale the precision to the magnitude
 * instead, which keeps every tick on an axis distinct.
 */
function costTick(value: number): string {
  if (value === 0) {
    return "$0";
  }
  const decimals = Math.min(
    6,
    Math.max(2, Math.ceil(-Math.log10(Math.abs(value))) + 1)
  );
  return `$${value.toFixed(decimals)}`;
}

function latencyTick(value: number): string {
  return value < 1000
    ? `${Math.round(value)}ms`
    : `${(value / 1000).toFixed(1)}s`;
}

/** Shared axis styling, so the three charts read as one set. */
function axisProps(palette: ChartPalette) {
  return {
    stroke: palette.axis,
    tick: { fill: palette.axis, fontSize: 11 },
    tickLine: false,
    axisLine: { stroke: palette.grid },
  } as const;
}

type TooltipEntry<T> = {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
  /** The datum the point came from, which every chart here keys its tooltip off. */
  payload?: T;
};

type TooltipRow = { label: string; value: string };

/**
 * Recharts' own tooltip takes inline styles, which would mean two more
 * places holding theme colours. This one is a plain element in the app's
 * semantic classes, so it follows the theme for free. Recharts clones it
 * and injects `active` and `payload`, which is why both are optional.
 */
function ChartTooltip<T>({
  active,
  payload,
  title,
  rows,
}: {
  active?: boolean;
  payload?: TooltipEntry<T>[];
  title: (datum: T) => string;
  rows: (datum: T, entries: TooltipEntry<T>[]) => TooltipRow[];
}) {
  const datum = payload?.[0]?.payload;
  if (!active || !payload || datum === undefined) {
    return null;
  }
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2 shadow-lg">
      <p className="mb-1 font-mono text-xs text-accent">{title(datum)}</p>
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
        {rows(datum, payload).map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-[0.625rem] uppercase tracking-wider text-muted">
              {row.label}
            </dt>
            <dd className="text-right font-mono text-xs text-body">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <Panel className="flex flex-col gap-1 px-4 py-3">
      <span className="text-[0.625rem] uppercase tracking-wider text-muted">
        {label}
      </span>
      <span
        className={`font-mono text-lg ${accent ? "text-accent" : "text-body"}`}
      >
        {value}
      </span>
    </Panel>
  );
}

function ChartCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Panel className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-xs uppercase tracking-wider text-muted">{title}</h2>
        {hint && <p className="text-[0.6875rem] text-muted">{hint}</p>}
      </div>
      {children}
    </Panel>
  );
}

/** A chart's own placeholder, so the card keeps its size and the page does not jump. */
function ChartNote({ message }: { message: string }) {
  return (
    <div className="flex h-56 items-center justify-center text-sm text-muted">
      {message}
    </div>
  );
}

/**
 * Latency per call with a trailing moving average over it. The raw series is
 * a faint area because a single cold start is real but not the story; the
 * average is the line worth reading.
 */
function LatencyTrend({
  points,
  palette,
}: {
  points: CallPoint[];
  palette: ChartPalette;
}) {
  if (points.length < 2) {
    return <ChartNote message="Two successful calls draw the first trend." />;
  }

  const axis = axisProps(palette);

  // The X axis is the call sequence, not elapsed time, so a burst does not
  // squash into a sliver next to a quiet day. The ticks still carry when
  // each call happened, which needs the date once the series spans days.
  const multiDay =
    points[points.length - 1].timestamp - points[0].timestamp > DAY_MS;

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={points}
          margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient id="latency-fill" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={seriesColor(palette, 1)}
                stopOpacity={0.35}
              />
              <stop
                offset="100%"
                stopColor={seriesColor(palette, 1)}
                stopOpacity={0.02}
              />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={palette.grid} vertical={false} />
          <XAxis
            {...axis}
            dataKey="seq"
            interval="preserveStartEnd"
            minTickGap={80}
            tickFormatter={(value: number) => {
              const at = points[value - 1]?.timestamp;
              if (at === undefined) {
                return "";
              }
              return multiDay ? dateLabel(at) : timeLabel(at);
            }}
          />
          <YAxis {...axis} width={52} tickFormatter={latencyTick} />
          <Tooltip
            cursor={{ stroke: palette.axis, strokeDasharray: "3 3" }}
            content={
              <ChartTooltip<CallPoint>
                title={(point) =>
                  `${shortModelName(point.model)} · ${
                    multiDay ? `${dateLabel(point.timestamp)} ` : ""
                  }${timeLabel(point.timestamp)}`
                }
                rows={(_point, entries) =>
                  entries.map((entry) => ({
                    label: String(entry.name ?? ""),
                    value: formatLatency(Number(entry.value ?? 0)),
                  }))
                }
              />
            }
          />
          <Legend
            iconType="plainline"
            wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
            formatter={(value: string) => (
              <span className="text-soft">{value}</span>
            )}
          />
          <Area
            type="monotone"
            dataKey="latencyMs"
            name="Per call"
            stroke={seriesColor(palette, 1)}
            strokeWidth={1}
            strokeOpacity={0.55}
            fill="url(#latency-fill)"
            isAnimationActive={false}
            activeDot={{ r: 3 }}
          />
          <Line
            type="monotone"
            dataKey="rollingLatencyMs"
            name="Rolling average"
            stroke={seriesColor(palette, 0)}
            strokeWidth={2.5}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Cost against latency, one bubble per model, sized by how many calls that
 * model handled. The comparison a table makes you compute across five
 * columns is a position on two axes here: cheap and fast is bottom left.
 */
function ModelScatter({
  rollups,
  palette,
}: {
  rollups: LedgerModelRollup[];
  palette: ChartPalette;
}) {
  if (rollups.length === 0) {
    return <ChartNote message="No successful calls to compare yet." />;
  }

  const axis = axisProps(palette);
  const maxCalls = Math.max(...rollups.map((rollup) => rollup.calls));

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 10, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={palette.grid} />
          <XAxis
            {...axis}
            type="number"
            dataKey="avgLatencyMs"
            name="Avg latency"
            domain={["auto", "auto"]}
            padding={{ left: 28, right: 28 }}
            tickFormatter={latencyTick}
          />
          <YAxis
            {...axis}
            type="number"
            dataKey="avgCostUsd"
            name="Avg cost"
            width={66}
            domain={["auto", "auto"]}
            padding={{ top: 20, bottom: 20 }}
            tickFormatter={costTick}
          />
          {/* One call and a hundred calls must not be the same dot. */}
          <ZAxis
            type="number"
            dataKey="calls"
            domain={[0, maxCalls]}
            range={BUBBLE_RANGE}
          />
          <Tooltip
            cursor={{ stroke: palette.axis, strokeDasharray: "3 3" }}
            content={
              <ChartTooltip<LedgerModelRollup>
                title={(rollup) => shortModelName(rollup.model)}
                rows={(rollup) => [
                  { label: "Calls", value: String(rollup.calls) },
                  {
                    label: "Avg latency",
                    value: formatLatency(rollup.avgLatencyMs),
                  },
                  { label: "Avg cost", value: formatCost(rollup.avgCostUsd) },
                  {
                    label: "Avg out",
                    value: `${formatTokens(rollup.avgCompletionTokens)} tok`,
                  },
                ]}
              />
            }
          />
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
            formatter={(value: string) => (
              <span className="text-soft">{value}</span>
            )}
          />
          {rollups.map((rollup, index) => (
            <Scatter
              key={rollup.model}
              name={shortModelName(rollup.model)}
              data={[rollup]}
              fill={seriesColor(palette, index)}
              fillOpacity={0.75}
              stroke={seriesColor(palette, index)}
              isAnimationActive={false}
            />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Call volume as bars with the spend in that same slot as a line over it. */
function TrafficTrend({
  buckets,
  granularity,
  palette,
}: {
  buckets: TrendBucket[];
  granularity: BucketGranularity;
  palette: ChartPalette;
}) {
  if (buckets.length === 0) {
    return <ChartNote message="Nothing has been recorded yet." />;
  }

  const axis = axisProps(palette);

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={buckets}
          margin={{ top: 10, right: 8, bottom: 0, left: 0 }}
        >
          <CartesianGrid stroke={palette.grid} vertical={false} />
          <XAxis
            {...axis}
            dataKey="start"
            interval="preserveStartEnd"
            minTickGap={40}
            tickFormatter={(value: number) => bucketLabel(value, granularity)}
          />
          <YAxis {...axis} yAxisId="calls" width={32} allowDecimals={false} />
          <YAxis
            {...axis}
            yAxisId="cost"
            orientation="right"
            width={66}
            tickFormatter={costTick}
          />
          <Tooltip
            cursor={{ fill: palette.grid, fillOpacity: 0.5 }}
            content={
              <ChartTooltip<TrendBucket>
                title={(bucket) => bucketLabel(bucket.start, granularity)}
                rows={(bucket, entries) => [
                  ...entries.map((entry) => ({
                    label: String(entry.name ?? ""),
                    value:
                      entry.dataKey === "costUsd"
                        ? formatCost(Number(entry.value ?? 0))
                        : String(entry.value ?? 0),
                  })),
                  ...(bucket.calls > 0
                    ? [
                        {
                          label: "Avg latency",
                          value: formatLatency(bucket.avgLatencyMs),
                        },
                      ]
                    : []),
                  ...(bucket.errors > 0
                    ? [{ label: "Failed", value: String(bucket.errors) }]
                    : []),
                ]}
              />
            }
          />
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
            formatter={(value: string) => (
              <span className="text-soft">{value}</span>
            )}
          />
          <Bar
            yAxisId="calls"
            dataKey="calls"
            name="Calls"
            fill={seriesColor(palette, 2)}
            fillOpacity={0.7}
            radius={[3, 3, 0, 0]}
            maxBarSize={MAX_BAR_WIDTH}
            isAnimationActive={false}
          />
          <Line
            yAxisId="cost"
            type="monotone"
            dataKey="costUsd"
            name="Spend"
            stroke={seriesColor(palette, 3)}
            strokeWidth={2}
            dot={{ r: 2 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * A short log rather than the whole ledger. It earns its place next to the
 * charts by showing the two things a chart of successful calls cannot: what
 * was asked for versus what routing resolved to, and which calls failed.
 */
function RecentActivity({ rows }: { rows: LedgerRow[] }) {
  return (
    <ul className="flex flex-col divide-y divide-line">
      {rows.map((row) => (
        <li
          key={row.requestId}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-xs"
        >
          <span className="font-mono text-muted">
            {timeLabel(Date.parse(row.timestamp))}
          </span>
          <span
            className={`font-mono ${row.status === "ok" ? "text-accent" : "text-danger"}`}
          >
            {row.status === "ok"
              ? shortModelName(row.resolvedModel)
              : "call failed"}
          </span>
          <span className="text-muted">via {row.requested}</span>
          <span className="ml-auto flex gap-3 font-mono text-soft">
            <span>{formatLatency(row.latencyMs)}</span>
            <span>{formatCost(row.costUsd)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Every proxied call writes a row to DynamoDB with its routing decision,
 * resolved model, observed tokens, latency, and cost. This view reads those
 * rows back, so the numbers are measurements of traffic this demo actually
 * made rather than list-price arithmetic on hypothetical token counts.
 *
 * The ledger is keyed by UTC calendar day and nothing else, so the read is
 * not scoped to a browser: these are every visitor's calls, pooled.
 */
export function ObservedPanel() {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [rollups, setRollups] = useState<LedgerModelRollup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);

  const palette = useChartPalette();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const ledger = await fetchLedger(signal);
      setRows(ledger.rows);
      setRollups(ledger.rollups);
      setError(null);
    } catch (caught) {
      if (!signal?.aborted) {
        setError(
          caught instanceof Error ? caught.message : "Ledger unavailable"
        );
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const points = useMemo(() => buildCallSeries(rows), [rows]);
  const granularity = useMemo(() => chooseGranularity(rows), [rows]);
  const buckets = useMemo(
    () => bucketRows(rows, granularity),
    [rows, granularity]
  );
  const summary = useMemo(() => summarise(rows), [rows]);

  const empty = loaded && rows.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-sm text-muted">
          Real cost and speed, measured across every visitor&rsquo;s calls.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto rounded-lg border border-line px-3 py-1.5 text-xs text-soft transition hover:border-accent hover:text-body disabled:opacity-50"
        >
          {loading ? "Reading" : "Refresh"}
        </button>
      </div>

      {error && <ErrorNote message={error} />}

      {!loaded && !error && (
        <Panel className="flex h-40 items-center justify-center">
          <p className="text-sm text-muted">Reading the ledger</p>
        </Panel>
      )}

      {empty && !error && (
        <Panel className="flex h-40 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-sm text-body">No calls recorded yet.</p>
          <p className="text-sm text-muted">
            Send a prompt from Chat or Compare and this view fills in.
          </p>
        </Panel>
      )}

      {loaded && rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Calls" value={String(summary.calls)} />
            <Metric label="Models" value={String(summary.models)} />
            <Metric
              label="Median latency"
              value={formatLatency(summary.medianLatencyMs)}
            />
            <Metric
              label="Total spend"
              value={formatCost(summary.totalCostUsd)}
              accent
            />
          </div>

          <ChartCard
            title="Observed latency"
            hint={`per call, smoothed over ${rollingWindow(points.length)}`}
          >
            <LatencyTrend points={points} palette={palette} />
          </ChartCard>

          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard
              title="Cost against latency"
              hint="one bubble per model, sized by call volume"
            >
              <ModelScatter rollups={rollups} palette={palette} />
            </ChartCard>

            <ChartCard
              title={
                granularity === "day" ? "Traffic by day" : "Traffic by hour"
              }
              hint={summary.errors > 0 ? `${summary.errors} failed` : undefined}
            >
              <TrafficTrend
                buckets={buckets}
                granularity={granularity}
                palette={palette}
              />
            </ChartCard>
          </div>

          <Panel className="flex flex-col gap-1 px-4 py-3">
            <h2 className="text-xs uppercase tracking-wider text-muted">
              Latest calls
            </h2>
            <RecentActivity rows={rows.slice(0, ACTIVITY_ROWS)} />
          </Panel>
        </>
      )}
    </div>
  );
}
