// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_QUERY } from "../src/responsive";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SESSIONS = [
  {
    id: "s-1",
    lastMessageAt: new Date().toISOString(),
    preview: "Open one",
    title: "Open one",
    pinned: false,
    archived: false,
  },
];

vi.mock("../src/api", () => ({
  getSessionId: () => "s-current",
  rememberSessionId: (id: string) => id,
  startSession: () => "s-new",
  fetchSession: () => Promise.resolve([]),
  fetchSessions: () => Promise.resolve({ sessions: SESSIONS, cursor: null }),
  patchSession: () => Promise.resolve(),
  streamChat: () => Promise.resolve(),
}));

const { ChatPanel } = await import("../src/components/ChatPanel");

/** Report the given viewport for the breakpoint query, desktop for anything else. */
function setViewport(isMobile: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === MOBILE_QUERY ? isMobile : !isMobile,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function sidebar() {
  return screen.getByRole("complementary", { name: "Chat history" });
}

/** `classList` and not `className`: `md:translate-x-0` is always in the string. */
function offCanvas() {
  return sidebar().classList.contains("-translate-x-full");
}

async function renderChat() {
  render(<ChatPanel models={[]} />);
  await waitFor(() => expect(screen.getByText("Open one")).toBeDefined());
}

beforeEach(() => {
  Element.prototype.scrollTo = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("history drawer below the breakpoint", () => {
  beforeEach(() => setViewport(true));

  it("starts closed and out of the tab order", async () => {
    await renderChat();
    expect(offCanvas()).toBe(true);
    expect(sidebar().hasAttribute("inert")).toBe(true);
  });

  it("opens from the menu button", async () => {
    await renderChat();
    act(() => screen.getByLabelText("Show chat history").click());
    expect(offCanvas()).toBe(false);
    expect(sidebar().hasAttribute("inert")).toBe(false);
  });

  it("closes itself when a conversation is opened", async () => {
    await renderChat();
    act(() => screen.getByLabelText("Show chat history").click());
    act(() => screen.getByText("Open one").click());
    await waitFor(() => expect(offCanvas()).toBe(true));
  });

  it("closes itself when a new chat is started", async () => {
    await renderChat();
    act(() => screen.getByLabelText("Show chat history").click());
    act(() => screen.getByText("New chat").click());
    await waitFor(() => expect(offCanvas()).toBe(true));
  });

  it("closes on Escape", async () => {
    await renderChat();
    act(() => screen.getByLabelText("Show chat history").click());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(offCanvas()).toBe(true);
  });
});

describe("history rail from the breakpoint up", () => {
  beforeEach(() => setViewport(false));

  it("is on screen and reachable without a menu button", async () => {
    await renderChat();
    expect(offCanvas()).toBe(false);
    expect(sidebar().hasAttribute("inert")).toBe(false);
  });

  it("stays put when a conversation is opened", async () => {
    await renderChat();
    act(() => screen.getByText("Open one").click());
    await waitFor(() => expect(sidebar().hasAttribute("inert")).toBe(false));
    expect(offCanvas()).toBe(false);
  });
});
