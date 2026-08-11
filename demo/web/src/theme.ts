export type Theme = "light" | "dark";

/** Shared with the inline script in index.html, which runs before first paint. */
export const THEME_STORAGE_KEY = "gloo_demo_theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function storedTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    // Safari private browsing throws on localStorage. The OS preference is
    // still a perfectly good answer.
    return null;
  }
}

/**
 * The theme the page is already painted in. index.html resolved it before
 * React loaded, so this reads the result rather than deciding again: two
 * independent resolutions of the same rules could disagree for one frame.
 */
export function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Without storage the choice lasts for the page view, which is the most
    // the browser is willing to offer.
  }
}

/**
 * Follow the OS while the visitor has never chosen explicitly. Once they
 * have, their choice outranks it and this stops firing. Returns the
 * unsubscribe function.
 */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  const handler = (event: MediaQueryListEvent) => {
    if (storedTheme() === null) {
      onChange(event.matches ? "dark" : "light");
    }
  };
  query.addEventListener("change", handler);
  return () => query.removeEventListener("change", handler);
}
