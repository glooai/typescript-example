import { useCallback, useEffect, useState } from "react";
import { fetchLedger } from "../api";
import {
  formatCost,
  formatLatency,
  formatTokens,
  shortModelName,
} from "../format";
import type { LedgerModelRollup, LedgerRow } from "../types";
import { ErrorNote, Panel } from "./ui";

/**
 * Every proxied call writes a row to DynamoDB with its routing decision,
 * resolved model, observed tokens, latency, and cost. This view reads those
 * rows back, so the numbers are measurements of traffic this demo actually
 * made rather than list-price arithmetic on hypothetical token counts.
 */
export function ObservedPanel() {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [rollups, setRollups] = useState<LedgerModelRollup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted">
          Real cost and speed from recent traffic.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto rounded-lg border border-line px-3 py-1.5 text-xs text-soft transition hover:border-accent hover:text-body"
        >
          Refresh
        </button>
      </div>

      {error && <ErrorNote message={error} />}

      <Panel className="overflow-hidden">
        <h2 className="border-b border-line px-4 py-3 text-xs uppercase tracking-wider text-muted">
          Per model
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-muted">
                <th className="px-4 py-2 font-normal">Model</th>
                <th className="px-4 py-2 font-normal">Calls</th>
                <th className="px-4 py-2 font-normal">Avg latency</th>
                <th className="px-4 py-2 font-normal">Avg cost</th>
                <th className="px-4 py-2 font-normal">Avg out tokens</th>
              </tr>
            </thead>
            <tbody>
              {rollups.map((rollup) => (
                <tr key={rollup.model} className="border-t border-line">
                  <td className="px-4 py-2 font-mono text-xs text-accent">
                    {shortModelName(rollup.model)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {rollup.calls}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {formatLatency(rollup.avgLatencyMs)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {formatCost(rollup.avgCostUsd)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {formatTokens(rollup.avgCompletionTokens)}
                  </td>
                </tr>
              ))}
              {rollups.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-sm text-muted">
                    {loading ? "Loading" : "No calls recorded yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <h2 className="border-b border-line px-4 py-3 text-xs uppercase tracking-wider text-muted">
          Recent calls
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-muted">
                <th className="px-4 py-2 font-normal">When</th>
                <th className="px-4 py-2 font-normal">Requested</th>
                <th className="px-4 py-2 font-normal">Resolved</th>
                <th className="px-4 py-2 font-normal">Latency</th>
                <th className="px-4 py-2 font-normal">Tokens</th>
                <th className="px-4 py-2 font-normal">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.requestId} className="border-t border-line">
                  <td className="px-4 py-2 font-mono text-xs text-soft">
                    {new Date(row.timestamp).toLocaleTimeString()}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-soft">
                    {row.requested}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-accent">
                    {row.status === "ok"
                      ? shortModelName(row.resolvedModel)
                      : "failed"}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {formatLatency(row.latencyMs)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {formatTokens(row.promptTokens)} /{" "}
                    {formatTokens(row.completionTokens)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {formatCost(row.costUsd)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-sm text-muted">
                    {loading ? "Loading" : "No calls recorded yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
