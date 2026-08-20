/** Display helpers. Costs here are fractions of a cent, so they need care. */

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function formatCost(usd: number | null): string {
  if (usd === null) {
    return "unpriced";
  }
  if (usd === 0) {
    return "$0";
  }
  // A typical demo call lands around $0.001, well under cent resolution.
  return usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(4)}`;
}

export function formatTokens(count: number): string {
  return count.toLocaleString("en-US");
}

/** `gloo-anthropic-claude-haiku-4.5` reads better as `claude haiku 4.5`. */
export function shortModelName(modelId: string | null): string {
  if (!modelId) {
    return "unresolved";
  }
  return modelId.replace(/^gloo-/, "").replace(/-/g, " ");
}
