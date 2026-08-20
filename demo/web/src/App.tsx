import { Suspense, lazy, useEffect, useState } from "react";
import { fetchModels } from "./api";
import { ChatPanel } from "./components/ChatPanel";
import { ComparePanel } from "./components/ComparePanel";
import { ThemeToggle } from "./components/ThemeToggle";
import type { ModelSummary } from "./types";

/*
 * Observed is the only view that draws charts, and the charting library is
 * most of the bundle. Splitting it out keeps that weight off the first load
 * of Chat, which is the view every visitor lands on; the chunk is fetched
 * the first time someone opens the tab.
 */
const ObservedPanel = lazy(() =>
  import("./components/ObservedPanel").then((module) => ({
    default: module.ObservedPanel,
  }))
);

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
    <div className="mx-auto flex h-dvh max-w-6xl flex-col gap-4 px-4 py-4 sm:gap-5 sm:px-5 sm:py-6">
      {/* Two rows on a phone (title with the theme toggle, then the tabs across
          the full width) and the original single row from `sm` up, which is the
          narrowest viewport all three fit on without wrapping. */}
      <header className="grid flex-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
            Gloo AI <span className="text-accent">Completions V2</span>
          </h1>
          <p className="hidden text-xs text-muted sm:block">
            Chat, compare models side by side, and see real cost and speed.
          </p>
        </div>

        <div className="col-start-2 row-start-1 sm:order-last">
          <ThemeToggle />
        </div>

        <nav
          aria-label="Views"
          className="col-span-2 row-start-2 flex rounded-xl border border-line bg-surface p-1 sm:ml-auto"
        >
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={tab === entry.id ? "page" : undefined}
              onClick={() => setTab(entry.id)}
              className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-lg px-3.5 text-sm transition sm:min-h-8 sm:flex-none ${
                tab === entry.id
                  ? "bg-raised text-body"
                  : "text-muted hover:bg-inset hover:text-soft"
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
        {tab === "observed" && (
          <Suspense
            fallback={
              <p className="px-1 text-sm text-muted">Loading the charts</p>
            }
          >
            <ObservedPanel />
          </Suspense>
        )}
      </main>
    </div>
  );
}
