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
