import { useEffect, useState } from "react";
import { fetchModels } from "./api";
import { ChatPanel } from "./components/ChatPanel";
import { ComparePanel } from "./components/ComparePanel";
import { ObservedPanel } from "./components/ObservedPanel";
import type { ModelSummary } from "./types";

const TABS = [
  { id: "chat", label: "Chat" },
  { id: "compare", label: "Compare" },
  { id: "observed", label: "Observed" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function App() {
  const [tab, setTab] = useState<TabId>("chat");
  const [models, setModels] = useState<ModelSummary[]>([]);

  // The model catalog comes from the platform registry through the proxy,
  // so the picker cannot drift from what the API will actually accept.
  useEffect(() => {
    const controller = new AbortController();
    fetchModels(controller.signal)
      .then(setModels)
      .catch(() => {
        // An empty catalog degrades the exact-model picker, nothing else.
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="mx-auto flex h-dvh max-w-6xl flex-col gap-5 px-5 py-6">
      <header className="flex flex-none flex-wrap items-center gap-x-4 gap-y-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Gloo AI <span className="text-gold-500">Completions V2</span>
          </h1>
          <p className="text-xs text-ink-500">
            Streaming chat and side by side routing comparison, proxied through
            a Lambda that holds the API key.
          </p>
        </div>

        <nav
          aria-label="Views"
          className="ml-auto flex rounded-xl border border-ink-800 bg-ink-900 p-1"
        >
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={tab === entry.id ? "page" : undefined}
              onClick={() => setTab(entry.id)}
              className={`rounded-lg px-3.5 py-1.5 text-sm transition ${
                tab === entry.id
                  ? "bg-ink-800 text-ink-100"
                  : "text-ink-500 hover:text-ink-300"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex min-h-0 flex-1 flex-col">
        {tab === "chat" && <ChatPanel models={models} />}
        {tab === "compare" && <ComparePanel models={models} />}
        {tab === "observed" && <ObservedPanel />}
      </main>
    </div>
  );
}
