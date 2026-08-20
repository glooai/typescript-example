import { useState } from "react";
import { getSessionId, runComparison } from "../api";
import {
  formatCost,
  formatLatency,
  formatTokens,
  shortModelName,
} from "../format";
import type { CompareResult, ModelSummary, RoutingSelection } from "../types";
import { Markdown } from "./Markdown";
import { RoutingPicker } from "./RoutingPicker";
import { ErrorNote, Panel, Stat } from "./ui";

const DEFAULT_VARIANTS: RoutingSelection[] = [
  { mode: "auto_routing" },
  { mode: "model_family", modelFamily: "anthropic" },
  { mode: "model", model: "gloo-openai-gpt-5-mini" },
];

const MAX_VARIANTS = 4;

const DEFAULT_PROMPT =
  "In three sentences, explain what makes a good technical explanation.";

/** Index of the cheapest and fastest successful results, for the badges. */
function findWinners(results: CompareResult[]): {
  fastest: string | null;
  cheapest: string | null;
} {
  const ok = results.filter((result) => result.status === "ok");
  const priced = ok.filter((result) => result.costUsd !== null);

  const fastest = ok.reduce<CompareResult | null>(
    (best, result) =>
      !best || result.latencyMs < best.latencyMs ? result : best,
    null
  );
  const cheapest = priced.reduce<CompareResult | null>(
    (best, result) =>
      !best || (result.costUsd ?? 0) < (best.costUsd ?? 0) ? result : best,
    null
  );

  return {
    fastest: fastest?.requestId ?? null,
    cheapest: cheapest?.requestId ?? null,
  };
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded-full bg-gold-500/15 px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-gold-500">
      {children}
    </span>
  );
}

function ResultCard({
  result,
  badges,
}: {
  result: CompareResult;
  badges: string[];
}) {
  return (
    <Panel className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-4 py-3">
        <span className="font-mono text-sm text-gold-500">
          {shortModelName(result.resolvedModel)}
        </span>
        <span className="text-xs text-ink-500">via {result.requested}</span>
        <span className="ml-auto flex gap-1.5">
          {badges.map((badge) => (
            <Badge key={badge}>{badge}</Badge>
          ))}
        </span>
      </div>

      <div className="max-h-80 flex-1 overflow-y-auto px-4 py-3.5">
        {result.status === "ok" ? (
          <Markdown>{result.text}</Markdown>
        ) : (
          <p className="text-sm text-red-300">
            {result.errorMessage ?? "The call failed."}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-ink-800 px-4 py-3">
        <Stat label="Latency" value={formatLatency(result.latencyMs)} />
        <Stat label="Cost" value={formatCost(result.costUsd)} />
        <Stat
          label="Out tokens"
          value={formatTokens(result.completionTokens)}
        />
        {result.routingTier && <Stat label="Tier" value={result.routingTier} />}
      </div>
    </Panel>
  );
}

/**
 * Send one prompt across several routing mechanisms at once and show the
 * real responses side by side with measured latency and cost. This is the
 * comparison that the routing table in the Gloo docs describes in the
 * abstract, run against live traffic.
 */
export function ComparePanel({ models }: { models: ModelSummary[] }) {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [variants, setVariants] =
    useState<RoutingSelection[]>(DEFAULT_VARIANTS);
  const [results, setResults] = useState<CompareResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy initialiser: getSessionId can write to localStorage, which must
  // not happen on every render.
  const [sessionId] = useState(getSessionId);

  function updateVariant(index: number, next: RoutingSelection) {
    setVariants((current) =>
      current.map((variant, position) => (position === index ? next : variant))
    );
  }

  async function run() {
    if (busy || prompt.trim().length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResults(
        await runComparison({ sessionId, prompt: prompt.trim(), variants })
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Comparison failed");
    } finally {
      setBusy(false);
    }
  }

  const winners = results
    ? findWinners(results)
    : { fastest: null, cheapest: null };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
      <Panel className="flex flex-col gap-4 p-4">
        <label className="flex flex-col gap-2">
          <span className="text-xs uppercase tracking-wider text-ink-500">
            Prompt
          </span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            className="resize-none rounded-xl border border-ink-800 bg-ink-850 px-3.5 py-3 text-sm outline-none transition placeholder:text-ink-500 focus:border-gold-500"
          />
        </label>

        <div className="flex flex-col gap-3">
          {variants.map((variant, index) => (
            <div
              key={index}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-800 bg-ink-850 px-3 py-2.5"
            >
              <span className="font-mono text-xs text-ink-500">
                {String(index + 1).padStart(2, "0")}
              </span>
              <RoutingPicker
                value={variant}
                onChange={(next) => updateVariant(index, next)}
                models={models}
                showTradition={false}
              />
              {variants.length > 2 && (
                <button
                  type="button"
                  onClick={() =>
                    setVariants((current) =>
                      current.filter((_, position) => position !== index)
                    )
                  }
                  className="ml-auto text-xs text-ink-500 transition hover:text-ink-100"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy || prompt.trim().length === 0}
            className="rounded-xl bg-gold-500 px-5 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-gold-400 disabled:opacity-40"
          >
            {busy ? "Running" : "Run comparison"}
          </button>
          {variants.length < MAX_VARIANTS && (
            <button
              type="button"
              onClick={() =>
                setVariants((current) => [...current, { mode: "auto_routing" }])
              }
              className="text-xs text-ink-500 transition hover:text-ink-100"
            >
              Add a variant
            </button>
          )}
          <span className="ml-auto text-xs text-ink-500">
            All variants run concurrently against the same prompt.
          </span>
        </div>
      </Panel>

      {error && <ErrorNote message={error} />}

      {busy && (
        <p className="px-1 text-sm text-ink-500">
          Waiting on {variants.length} routing variants
        </p>
      )}

      {results && !busy && (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {results.map((result) => (
            <ResultCard
              key={result.requestId}
              result={result}
              badges={[
                ...(result.requestId === winners.fastest ? ["fastest"] : []),
                ...(result.requestId === winners.cheapest ? ["cheapest"] : []),
              ]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
