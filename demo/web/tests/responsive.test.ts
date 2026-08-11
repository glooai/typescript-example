import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOBILE_QUERY,
  isMobileViewport,
  watchMobileViewport,
} from "../src/responsive";

type Listener = (event: { matches: boolean }) => void;

/** The slice of `window` these functions touch, and nothing else. */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  const queries: string[] = [];
  const media = {
    matches,
    addEventListener: (_type: string, listener: Listener) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) =>
      listeners.delete(listener),
  };
  vi.stubGlobal("window", {
    matchMedia: (query: string) => {
      queries.push(query);
      return media;
    },
  });
  return {
    queries,
    listenerCount: () => listeners.size,
    emit: (next: boolean) =>
      listeners.forEach((listener) => listener({ matches: next })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("MOBILE_QUERY", () => {
  it("is the exact complement of Tailwind's md breakpoint", () => {
    expect(MOBILE_QUERY).toBe("(max-width: 47.99rem)");
  });
});

describe("isMobileViewport", () => {
  it("reports what the media query says", () => {
    stubMatchMedia(true);
    expect(isMobileViewport()).toBe(true);

    stubMatchMedia(false);
    expect(isMobileViewport()).toBe(false);
  });

  it("asks about the mobile breakpoint and nothing else", () => {
    const media = stubMatchMedia(true);
    isMobileViewport();
    expect(media.queries).toEqual([MOBILE_QUERY]);
  });
});

describe("watchMobileViewport", () => {
  it("reports each crossing of the breakpoint", () => {
    const media = stubMatchMedia(false);
    const seen: boolean[] = [];

    watchMobileViewport((isMobile) => seen.push(isMobile));
    media.emit(true);
    media.emit(false);

    expect(seen).toEqual([true, false]);
  });

  it("unsubscribes when the returned function is called", () => {
    const media = stubMatchMedia(false);
    const seen: boolean[] = [];

    const stop = watchMobileViewport((isMobile) => seen.push(isMobile));
    expect(media.listenerCount()).toBe(1);

    stop();
    expect(media.listenerCount()).toBe(0);

    media.emit(true);
    expect(seen).toEqual([]);
  });
});
