import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchSession,
  fetchSessions,
  getSessionId,
  patchSession,
  rememberSessionId,
  startSession,
  streamChat,
} from "../api";
import {
  formatCost,
  formatLatency,
  formatTokens,
  shortModelName,
} from "../format";
import {
  historyEntries,
  TITLE_MAX_CHARS,
  type HistoryEntry,
} from "../sessions";
import type {
  CallMetrics,
  ChatMessage,
  ModelSummary,
  RoutingSelection,
  SessionPatch,
  SessionSummary,
} from "../types";
import { Markdown } from "./Markdown";
import { RoutingPicker } from "./RoutingPicker";
import { ErrorNote, Panel, Stat } from "./ui";

type Turn = ChatMessage & { metrics?: CallMetrics };

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
      <svg
        viewBox="0 0 256 256"
        fill="currentColor"
        aria-hidden="true"
        className="size-4"
      >
        <path d={path} />
      </svg>
    </button>
  );
}

const SUGGESTIONS = [
  "How does the Old Testament connect to the New Testament?",
  "Draft a three point outline for a sermon on Psalm 23.",
  "Explain the difference between grace and mercy in two paragraphs.",
];

function MetricsStrip({ metrics }: { metrics: CallMetrics }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-3">
      <Stat
        label="Resolved model"
        value={shortModelName(metrics.resolvedModel)}
        accent
      />
      <Stat label="Requested" value={metrics.requested} />
      {metrics.routingTier && <Stat label="Tier" value={metrics.routingTier} />}
      {metrics.ttftMs !== null && (
        <Stat label="First token" value={formatLatency(metrics.ttftMs)} />
      )}
      <Stat label="Total" value={formatLatency(metrics.latencyMs)} />
      <Stat
        label="Tokens in / out"
        value={`${formatTokens(metrics.promptTokens)} / ${formatTokens(metrics.completionTokens)}`}
      />
      <Stat label="Cost" value={formatCost(metrics.costUsd)} />
    </div>
  );
}

export function ChatPanel({ models }: { models: ModelSummary[] }) {
  const [routing, setRouting] = useState<RoutingSelection>({
    mode: "auto_routing",
  });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lazy initialiser: getSessionId can write to localStorage, which must
  // not happen on every render.
  const [sessionId, setSessionId] = useState(getSessionId);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Restore the previous transcript from DynamoDB so a refresh does not
  // lose the conversation. Metrics are not restored: they describe calls
  // made in an earlier page load.
  useEffect(() => {
    const controller = new AbortController();
    fetchSession(sessionId, controller.signal)
      .then((messages) => {
        if (messages.length > 0) {
          setTurns(messages);
        }
      })
      .catch(() => {
        // A missing or unreachable transcript just means an empty chat.
      });
    return () => controller.abort();
  }, [sessionId]);

  const loadHistory = useCallback(
    (signal?: AbortSignal) => {
      setHistoryLoading(true);
      return fetchSessions({ archived: showArchived, signal })
        .then(setSessions)
        .catch(() => {
          // No cookie, or an unreachable list: an empty history, not an error.
          setSessions([]);
        })
        .finally(() => {
          if (!signal?.aborted) {
            setHistoryLoading(false);
          }
        });
    },
    [showArchived]
  );

  // Fetched when the list is opened rather than on mount, so a visitor who
  // never opens history costs no extra request, and every open shows the
  // conversation they have just been adding turns to, including the title
  // that was generated for it after its first reply.
  useEffect(() => {
    if (!historyOpen) {
      return;
    }
    const controller = new AbortController();
    void loadHistory(controller.signal);
    return () => controller.abort();
  }, [historyOpen, loadHistory]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns]);

  /**
   * Move to another conversation. The transcript is cleared here rather than
   * left in place until the fetch lands, so the previous conversation is
   * never briefly shown under the new one's id.
   */
  function openSession(nextId: string) {
    setHistoryOpen(false);
    if (nextId === sessionId) {
      return;
    }
    abortRef.current?.abort();
    setError(null);
    setTurns([]);
    setSessionId(rememberSessionId(nextId));
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
    await loadHistory();
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

  function newChat() {
    setHistoryOpen(false);
    abortRef.current?.abort();
    setError(null);
    setTurns([]);
    setSessionId(startSession());
  }

  async function send(text: string) {
    const prompt = text.trim();
    if (!prompt || busy) {
      return;
    }

    const history: ChatMessage[] = [
      ...turns.map(({ role, content }) => ({ role, content })),
      { role: "user" as const, content: prompt },
    ];

    setError(null);
    setInput("");
    setBusy(true);
    setTurns([...history, { role: "assistant", content: "" }]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat({
        sessionId,
        messages: history,
        routing,
        signal: controller.signal,
        onDelta: (delta) =>
          setTurns((current) =>
            current.map((turn, index) =>
              index === current.length - 1
                ? { ...turn, content: turn.content + delta }
                : turn
            )
          ),
        onMeta: (metrics) =>
          setTurns((current) =>
            current.map((turn, index) =>
              index === current.length - 1 ? { ...turn, metrics } : turn
            )
          ),
      });
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "Request failed");
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  const lastTurn = turns[turns.length - 1];
  const streamingEmpty =
    busy && lastTurn?.role === "assistant" && lastTurn.content.length === 0;
  const entries = historyEntries(sessions, sessionId).filter(
    (entry) => entry.archived === showArchived
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Panel className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <RoutingPicker
            value={routing}
            onChange={setRouting}
            models={models}
          />

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setRenamingId(null);
                setHistoryOpen((open) => !open);
              }}
              aria-expanded={historyOpen}
              aria-controls="chat-history"
              className={`rounded-full border px-3.5 py-1.5 text-xs transition ${
                historyOpen
                  ? "border-accent text-body"
                  : "border-line bg-inset text-soft hover:border-accent hover:text-body"
              }`}
            >
              History
            </button>
            <button
              type="button"
              onClick={newChat}
              className="rounded-full border border-line bg-inset px-3.5 py-1.5 text-xs text-soft transition hover:border-accent hover:text-body"
            >
              New chat
            </button>
          </div>
        </div>

        {historyOpen && (
          <div id="chat-history" className="mt-3 border-t border-line pt-3">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[0.625rem] uppercase tracking-wider text-muted">
                {showArchived ? "Archived" : "Recent chats"}
              </span>
              {/* Archiving is recoverable only if there is somewhere to
                  recover it from, so the archived conversations get a view of
                  their own rather than being hidden until the TTL. */}
              <button
                type="button"
                onClick={() => {
                  setRenamingId(null);
                  setShowArchived((archived) => !archived);
                }}
                className="text-xs text-muted underline underline-offset-2 transition hover:text-body"
              >
                {showArchived ? "Back to recent" : "Show archived"}
              </button>
            </div>

            {entries.length === 0 ? (
              <p className="px-1 text-xs text-muted">
                {historyLoading
                  ? "Loading your chats"
                  : showArchived
                    ? "Nothing archived."
                    : "No past chats yet."}
              </p>
            ) : (
              <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                {entries.map((entry) => (
                  <li
                    key={entry.id}
                    className={`flex items-center gap-1 rounded-lg pr-1 transition hover:bg-inset ${
                      entry.active ? "bg-inset" : ""
                    }`}
                  >
                    {renamingId === entry.id ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          submitRename();
                        }}
                        className="flex min-w-0 flex-1 items-center gap-1 py-1 pl-2.5"
                      >
                        <input
                          type="text"
                          value={renameDraft}
                          autoFocus
                          maxLength={TITLE_MAX_CHARS}
                          onChange={(event) =>
                            setRenameDraft(event.target.value)
                          }
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
                          onClick={() => openSession(entry.id)}
                          aria-current={entry.active ? "true" : undefined}
                          className="flex min-w-0 flex-1 items-baseline gap-3 rounded-lg px-2.5 py-2 text-left"
                        >
                          <span className="min-w-0 flex-1 truncate text-sm text-soft">
                            {entry.title}
                          </span>
                          <span className="flex-none font-mono text-[0.625rem] text-muted">
                            {entry.when}
                          </span>
                        </button>
                        <RowAction
                          label={entry.pinned ? "Unpin chat" : "Pin chat"}
                          path={entry.pinned ? ICON_UNPIN : ICON_PIN}
                          active={entry.pinned}
                          onClick={() =>
                            void changeSession(entry.id, {
                              pinned: !entry.pinned,
                            })
                          }
                        />
                        <RowAction
                          label="Rename chat"
                          path={ICON_RENAME}
                          onClick={() => startRename(entry)}
                        />
                        <RowAction
                          label={
                            entry.archived ? "Restore chat" : "Archive chat"
                          }
                          path={entry.archived ? ICON_RESTORE : ICON_ARCHIVE}
                          onClick={() =>
                            void changeSession(entry.id, {
                              archived: !entry.archived,
                            })
                          }
                        />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Panel>

      {error && <ErrorNote message={error} />}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1"
      >
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <p className="text-sm text-muted">Ask something to get started.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void send(suggestion)}
                  className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-xs text-soft transition hover:border-accent hover:text-body"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, index) =>
          turn.role === "user" ? (
            <div key={index} className="flex justify-end">
              <p className="max-w-[80%] rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-sm whitespace-pre-wrap">
                {turn.content}
              </p>
            </div>
          ) : (
            <Panel key={index} className="px-4 py-3.5">
              <Markdown>{turn.content}</Markdown>
              {turn.metrics && <MetricsStrip metrics={turn.metrics} />}
            </Panel>
          )
        )}

        {streamingEmpty && (
          <p className="px-1 text-sm text-muted">Routing your request</p>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
        className="flex flex-none gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Send a message"
          aria-label="Message"
          disabled={busy}
          className="flex-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm outline-none transition placeholder:text-muted focus:border-accent disabled:opacity-60"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className="rounded-xl border border-line-strong px-5 py-3 text-sm font-medium text-soft transition hover:text-body"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={input.trim().length === 0}
            className="rounded-xl bg-accent-solid px-5 py-3 text-sm font-semibold text-on-accent transition hover:bg-accent-solid-hover disabled:opacity-40"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
