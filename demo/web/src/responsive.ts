import { useEffect, useState } from "react";

/**
 * The line between the phone layout and the desktop one, written as the exact
 * complement of Tailwind's `md` breakpoint (48rem). Layout that responds in
 * CSS uses `md:`; layout that only JavaScript can decide (Recharts axis
 * widths, whether the history sidebar is a drawer) reads this. Expressing it
 * once, in rem, keeps the two from ever disagreeing about which side of the
 * line a viewport is on.
 */
export const MOBILE_QUERY = "(max-width: 47.99rem)";

export function isMobileViewport(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}

/** Follow the viewport across rotations and resizes. Returns the unsubscribe. */
export function watchMobileViewport(
  onChange: (isMobile: boolean) => void
): () => void {
  const query = window.matchMedia(MOBILE_QUERY);
  const handler = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener("change", handler);
  return () => query.removeEventListener("change", handler);
}

export function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(isMobileViewport);
  useEffect(() => watchMobileViewport(setIsMobile), []);
  return isMobile;
}
