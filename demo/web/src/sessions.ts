/**
 * Presentation logic for the Chat view's history list.
 *
 * The server already returns a visitor's conversations newest first, so this
 * only turns each one into the two strings the list renders and marks which
 * conversation is open. It is pure and locale-free for the same reason the
 * Observed aggregation is: the arithmetic is testable without a DOM, and
 * anything the visitor's locale should decide is left to the browser.
 */
import type { SessionSummary } from "./types";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A conversation whose first turn carried no text still needs a label. */
const UNTITLED = "Untitled conversation";

/**
 * The rename field's cap, mirroring `TITLE_MAX_CHARS` in the API's
 * `title.ts`. The server enforces it too; this is here so the field stops
 * accepting characters rather than letting a visitor type a title that comes
 * back rejected.
 */
export const TITLE_MAX_CHARS = 40;

export type HistoryEntry = {
  id: string;
  title: string;
  when: string;
  active: boolean;
  pinned: boolean;
  archived: boolean;
};

/**
 * Coarse relative time. Conversations expire after twelve hours, so the
 * scale never needs to reach beyond a day, and a clock skew that puts a
 * timestamp slightly in the future reads as "just now" rather than as a
 * negative age.
 */
export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return "";
  }
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE_MS) {
    return "just now";
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  }
  return `${Math.floor(elapsed / DAY_MS)}d ago`;
}

/**
 * What a conversation is called in the list. A stored title wins whether the
 * visitor typed it or the model produced it, because both are a decision
 * about what this conversation is; the opening question is the fallback for a
 * conversation that has neither yet, which is every conversation for the few
 * seconds between its first reply and its generated name landing.
 */
export function historyTitle(session: SessionSummary): string {
  return session.title?.trim() || session.preview.trim() || UNTITLED;
}

export function historyEntries(
  sessions: SessionSummary[],
  currentId: string,
  now: number = Date.now()
): HistoryEntry[] {
  return sessions.map((session) => ({
    id: session.id,
    title: historyTitle(session),
    when: relativeTime(session.lastMessageAt, now),
    active: session.id === currentId,
    pinned: session.pinned,
    archived: session.archived,
  }));
}

/**
 * The two groups the sidebar labels separately when nothing is being searched.
 *
 * Pinned conversations sit above every recent one whatever their age, which is
 * the whole point of pinning and is also the one thing about this list that
 * reads as a bug when it is not spelled out: a chat sent a moment ago
 * appearing second, under one from an hour before, looks broken until the
 * heading says the one above it is pinned. Under a search the split is
 * dropped, because there the order is relevance and a "Pinned" heading would
 * be describing something that is no longer deciding the order.
 */
export function groupHistoryEntries(entries: HistoryEntry[]): {
  pinned: HistoryEntry[];
  recent: HistoryEntry[];
} {
  return {
    pinned: entries.filter((entry) => entry.pinned),
    recent: entries.filter((entry) => !entry.pinned),
  };
}

/** What `GET /api/sessions` is asked for: which list, matching what, from where. */
export type SessionsQuery = {
  archived?: boolean;
  query?: string;
  cursor?: string | null;
};

export function sessionsPath(options: SessionsQuery = {}): string {
  const params = new URLSearchParams();
  if (options.archived) {
    params.set("archived", "1");
  }
  const query = options.query?.trim();
  if (query) {
    params.set("q", query);
  }
  if (options.cursor) {
    params.set("cursor", options.cursor);
  }
  const search = params.toString();
  return search ? `/api/sessions?${search}` : "/api/sessions";
}

/**
 * Append the next page to what is already on screen, dropping any
 * conversation that appears twice. A duplicate is not a server fault: the
 * cursor names a position in an order derived from `last_message_at` and
 * `pinned`, and a conversation spoken to or pinned between two page reads
 * genuinely moves, so the row can land in both pages. Keeping the first copy
 * keeps it where the visitor already saw it.
 */
export function mergeSessionPage(
  loaded: SessionSummary[],
  next: SessionSummary[]
): SessionSummary[] {
  const seen = new Set(loaded.map((session) => session.id));
  return [...loaded, ...next.filter((session) => !seen.has(session.id))];
}
