import { useEffect, useRef, useState } from "react";
import {
  fetchSession,
  fetchSessions,
  getSessionId,
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
import { historyEntries } from "../sessions";
import type {
  CallMetrics,
  ChatMessage,
  ModelSummary,
  RoutingSelection,
  SessionSummary,
} from "../types";
import { Markdown } from "./Markdown";
import { RoutingPicker } from "./RoutingPicker";
import { ErrorNote, Panel, Stat } from "./ui";

type Turn = ChatMessage & { metrics?: CallMetrics };

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

  // Fetched when the list is opened rather than on mount, so a visitor who
  // never opens history costs no extra request, and every open shows the
  // conversation they have just been adding turns to.
  useEffect(() => {
    if (!historyOpen) {
      return;
    }
    const controller = new AbortController();
    setHistoryLoading(true);
    fetchSessions(controller.signal)
      .then(setSessions)
      .catch(() => {
        // No cookie, or an unreachable list: an empty history, not an error.
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setHistoryLoading(false);
        }
      });
    return () => controller.abort();
  }, [historyOpen]);

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
  const entries = historyEntries(sessions, sessionId);

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
              onClick={() => setHistoryOpen((open) => !open)}
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
            {entries.length === 0 ? (
              <p className="px-1 text-xs text-muted">
                {historyLoading ? "Loading your chats" : "No past chats yet."}
              </p>
            ) : (
              <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => openSession(entry.id)}
                      aria-current={entry.active ? "true" : undefined}
                      className={`flex w-full items-baseline gap-3 rounded-lg px-2.5 py-2 text-left transition hover:bg-inset ${
                        entry.active ? "bg-inset" : ""
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-soft">
                        {entry.title}
                      </span>
                      <span className="flex-none font-mono text-[0.625rem] text-muted">
                        {entry.when}
                      </span>
                    </button>
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
