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

export type HistoryEntry = {
  id: string;
  title: string;
  when: string;
  active: boolean;
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

export function historyEntries(
  sessions: SessionSummary[],
  currentId: string,
  now: number = Date.now()
): HistoryEntry[] {
  return sessions.map((session) => ({
    id: session.id,
    title: session.preview.trim() || UNTITLED,
    when: relativeTime(session.lastMessageAt, now),
    active: session.id === currentId,
  }));
}
