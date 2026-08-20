import { useCallback, useEffect, useState } from "react";
import { fetchSessions, patchSession } from "../api";
import {
  groupHistoryEntries,
  historyEntries,
  mergeSessionPage,
  TITLE_MAX_CHARS,
  type HistoryEntry,
} from "../sessions";
import type { SessionPatch, SessionSummary } from "../types";

/*
 * Phosphor Icons, regular weight, inlined the same way ThemeToggle does it:
 * real path data from @phosphor-icons/core rather than an icon package, which
 * a handful of glyphs does not earn in an app whose point is a narrow surface.
 */
const ICON_PIN =
  "M235.32,81.37,174.63,20.69a16,16,0,0,0-22.63,0L98.37,74.49c-10.66-3.34-35-7.37-60.4,13.14a16,16,0,0,0-1.29,23.78L85,159.71,42.34,202.34a8,8,0,0,0,11.32,11.32L96.29,171l48.29,48.29A16,16,0,0,0,155.9,224c.38,0,.75,0,1.13,0a15.93,15.93,0,0,0,11.64-6.33c19.64-26.1,17.75-47.32,13.19-60L235.33,104A16,16,0,0,0,235.32,81.37ZM224,92.69h0l-57.27,57.46a8,8,0,0,0-1.49,9.22c9.46,18.93-1.8,38.59-9.34,48.62L48,100.08c12.08-9.74,23.64-12.31,32.48-12.31A40.13,40.13,0,0,1,96.81,91a8,8,0,0,0,9.25-1.51L163.32,32,224,92.68Z";
const ICON_UNPIN =
  "M53.92,34.62A8,8,0,1,0,42.08,45.38L67.37,73.2A69.82,69.82,0,0,0,38,87.63a16,16,0,0,0-1.29,23.78L85,159.71,42.34,202.34a8,8,0,0,0,11.32,11.32L96.29,171l48.29,48.29A16,16,0,0,0,155.9,224c.38,0,.75,0,1.13,0a15.93,15.93,0,0,0,11.64-6.33,89.75,89.75,0,0,0,11.58-20.27l21.84,24a8,8,0,1,0,11.84-10.76ZM155.9,208,48,100.08C58.23,91.83,69.2,87.72,80.66,87.81l87.16,95.88C165.59,193.56,160.24,202.23,155.9,208Zm79.42-104-44.64,44.79a8,8,0,1,1-11.33-11.3L224,92.7,163.32,32,122.1,73.35a8,8,0,0,1-11.33-11.29L152,20.7a16,16,0,0,1,22.63,0l60.69,60.68A16,16,0,0,1,235.32,104Z";
const ICON_RENAME =
  "M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z";
const ICON_ARCHIVE =
  "M224,48H32A16,16,0,0,0,16,64V88a16,16,0,0,0,16,16v88a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V104a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48ZM208,192H48V104H208ZM224,88H32V64H224V88ZM96,136a8,8,0,0,1,8-8h48a8,8,0,0,1,0,16H104A8,8,0,0,1,96,136Z";
const ICON_RESTORE =
  "M224,128a96,96,0,0,1-94.71,96H128A95.38,95.38,0,0,1,62.1,197.8a8,8,0,0,1,11-11.63A80,80,0,1,0,71.43,71.39a3.07,3.07,0,0,1-.26.25L44.59,96H72a8,8,0,0,1,0,16H24a8,8,0,0,1-8-8V56a8,8,0,0,1,16,0V85.8L60.25,60A96,96,0,0,1,224,128Z";
const ICON_CONFIRM =
  "M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z";
const ICON_CANCEL =
  "M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z";
const ICON_SEARCH =
  "M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z";
const ICON_NEW =
  "M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z";

/** How long typing settles before the search reaches the API. */
const SEARCH_DEBOUNCE_MS = 200;

function Icon({ path, className }: { path: string; className: string }) {
  return (
    <svg
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d={path} />
    </svg>
  );
}

/** A small square icon button, the affordance every history row action uses. */
function RowAction({
  label,
  path,
  onClick,
  active = false,
}: {
  label: string;
  path: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex size-7 flex-none items-center justify-center rounded-md transition hover:bg-raised ${
        active ? "text-accent" : "text-muted hover:text-body"
      }`}
    >
      <Icon path={path} className="size-4" />
    </button>
  );
}

function GroupLabel({ children }: { children: string }) {
  return (
    <li className="px-2.5 pt-2 pb-1 text-[0.625rem] uppercase tracking-wider text-muted">
      {children}
    </li>
  );
}

export function ChatSidebar({
  currentId,
  onOpen,
  onNewChat,
  refreshToken,
}: {
  currentId: string;
  onOpen: (sessionId: string) => void;
  onNewChat: () => void;
  /** Bumped by the chat when a turn lands, so the list reflects it. */
  refreshToken: number;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Held back so a search is one request per pause rather than one per key.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadFirstPage = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      return fetchSessions({ archived: showArchived, query, signal })
        .then((page) => {
          setSessions(page.sessions);
          setCursor(page.cursor);
        })
        .catch(() => {
          // No cookie, or an unreachable list: an empty history, not an error.
          if (!signal?.aborted) {
            setSessions([]);
            setCursor(null);
          }
        })
        .finally(() => {
          if (!signal?.aborted) {
            setLoading(false);
          }
        });
    },
    [showArchived, query]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadFirstPage(controller.signal);
    return () => controller.abort();
  }, [loadFirstPage, refreshToken]);

  async function loadMore() {
    if (!cursor || loadingMore) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await fetchSessions({
        archived: showArchived,
        query,
        cursor,
      });
      setSessions((current) => mergeSessionPage(current, page.sessions));
      setCursor(page.cursor);
    } catch {
      // Nothing more can be offered from a cursor that failed to resolve.
      setCursor(null);
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Apply a change to a history entry. The row is updated locally first so
   * the affordance responds immediately, then the list is refetched, because
   * the server owns the ordering pinned conversations produce and re-deriving
   * it here would be a second copy of that rule.
   */
  async function changeSession(id: string, patch: SessionPatch) {
    setSessions((current) =>
      current.map((session) =>
        session.id === id ? { ...session, ...patch } : session
      )
    );
    try {
      await patchSession(id, patch);
    } catch {
      // A refused change is corrected by the refetch below.
    }
    await loadFirstPage();
  }

  function startRename(entry: HistoryEntry) {
    setRenamingId(entry.id);
    setRenameDraft(entry.title);
  }

  function submitRename() {
    const id = renamingId;
    const title = renameDraft.trim();
    setRenamingId(null);
    if (id && title) {
      void changeSession(id, { title });
    }
  }

  const entries = historyEntries(sessions, currentId).filter(
    (entry) => entry.archived === showArchived
  );
  const searching = query.trim().length > 0;
  const groups = groupHistoryEntries(entries);

  function renderRow(entry: HistoryEntry) {
    return (
      <li
        key={entry.id}
        className={`group relative flex items-center rounded-lg transition ${
          entry.active ? "bg-raised" : "hover:bg-inset"
        }`}
      >
        {renamingId === entry.id ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitRename();
            }}
            className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-1 pl-2"
          >
            <input
              type="text"
              value={renameDraft}
              autoFocus
              maxLength={TITLE_MAX_CHARS}
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setRenamingId(null);
                }
              }}
              aria-label="Chat name"
              className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-sm outline-none transition focus:border-accent"
            />
            <RowAction
              label="Save name"
              path={ICON_CONFIRM}
              onClick={submitRename}
            />
            <RowAction
              label="Cancel rename"
              path={ICON_CANCEL}
              onClick={() => setRenamingId(null)}
            />
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onOpen(entry.id)}
              aria-current={entry.active ? "true" : undefined}
              className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {/* The pin stays on the row and not only in the group heading,
                    so the reason a conversation outranks a newer one is still
                    legible once the list is scrolled past the heading. */}
                {entry.pinned && (
                  <Icon
                    path={ICON_PIN}
                    className="size-3 flex-none text-accent"
                  />
                )}
                <span
                  className={`min-w-0 truncate text-sm ${
                    entry.active ? "text-body" : "text-soft"
                  }`}
                >
                  {entry.title}
                </span>
              </span>
              <span className="font-mono text-[0.625rem] text-muted">
                {entry.when}
              </span>
            </button>
            {/* Over the row rather than beside it: the actions would otherwise
                hold a third of the width open on every row to be there for the
                one row being pointed at. Keyboard focus reveals them as
                pointing does, and a coarse pointer has no hover to reveal them
                with at all, so there they simply stay visible. */}
            <div
              className={`absolute right-1 flex items-center rounded-md opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100 ${
                entry.active ? "bg-raised" : "bg-inset"
              }`}
            >
              <RowAction
                label={entry.pinned ? "Unpin chat" : "Pin chat"}
                path={entry.pinned ? ICON_UNPIN : ICON_PIN}
                active={entry.pinned}
                onClick={() =>
                  void changeSession(entry.id, { pinned: !entry.pinned })
                }
              />
              <RowAction
                label="Rename chat"
                path={ICON_RENAME}
                onClick={() => startRename(entry)}
              />
              <RowAction
                label={entry.archived ? "Restore chat" : "Archive chat"}
                path={entry.archived ? ICON_RESTORE : ICON_ARCHIVE}
                onClick={() =>
                  void changeSession(entry.id, { archived: !entry.archived })
                }
              />
            </div>
          </>
        )}
      </li>
    );
  }

  return (
    <aside
      aria-label="Chat history"
      className="flex w-72 flex-none flex-col gap-3 rounded-2xl border border-line bg-surface p-3"
    >
      <button
        type="button"
        onClick={onNewChat}
        className="flex items-center justify-center gap-1.5 rounded-xl border border-line bg-inset px-3 py-2 text-sm text-soft transition hover:border-accent hover:text-body"
      >
        <Icon path={ICON_NEW} className="size-4" />
        New chat
      </button>

      <div className="relative">
        <Icon
          path={ICON_SEARCH}
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted"
        />
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
          className="w-full rounded-xl border border-line bg-inset py-1.5 pr-2.5 pl-8 text-sm outline-none transition placeholder:text-muted focus:border-accent"
        />
      </div>

      {/* Archiving is recoverable only if there is somewhere to recover it
          from, so the archived conversations get a view of their own rather
          than being hidden until the TTL. */}
      <button
        type="button"
        onClick={() => {
          setRenamingId(null);
          setShowArchived((archived) => !archived);
        }}
        aria-pressed={showArchived}
        className="self-start px-1 text-xs text-muted underline underline-offset-2 transition hover:text-body"
      >
        {showArchived ? "Back to recent" : "Show archived"}
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted">
            {loading
              ? "Loading your chats"
              : searching
                ? "Nothing matches that."
                : showArchived
                  ? "Nothing archived."
                  : "No past chats yet."}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {searching ? (
              entries.map(renderRow)
            ) : (
              <>
                {groups.pinned.length > 0 && (
                  <>
                    <GroupLabel>Pinned</GroupLabel>
                    {groups.pinned.map(renderRow)}
                  </>
                )}
                {groups.recent.length > 0 && (
                  <>
                    <GroupLabel>
                      {showArchived ? "Archived" : "Recent"}
                    </GroupLabel>
                    {groups.recent.map(renderRow)}
                  </>
                )}
              </>
            )}
          </ul>
        )}

        {cursor && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="mt-1 w-full rounded-lg px-2.5 py-2 text-xs text-muted transition hover:bg-inset hover:text-body disabled:opacity-50"
          >
            {loadingMore ? "Loading" : "Load more"}
          </button>
        )}
      </div>
    </aside>
  );
}
