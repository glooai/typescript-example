/**
 * Chart colours, read from the theme.
 *
 * Recharts renders SVG and takes every colour as an element prop, so it
 * understands neither a `--custom-property` nor a Tailwind `dark:` variant:
 * a `stroke="var(--chart-1)"` does resolve in the DOM, but the same value is
 * also handed to the tooltip, the legend swatch, and the animation
 * interpolator, which all want a real colour. So the values are read back
 * off the root element once and re-read whenever the theme class changes,
 * which keeps `index.css` the single place the palette is defined.
 */
import { useEffect, useState } from "react";

const SERIES_VARS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
] as const;

export type ChartPalette = {
  /** Categorical series colours, in the order they should be handed out. */
  series: string[];
  grid: string;
  axis: string;
  danger: string;
};

function readVar(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim();
}

function readPalette(): ChartPalette {
  const styles = getComputedStyle(document.documentElement);
  return {
    series: SERIES_VARS.map((name) => readVar(styles, name)),
    grid: readVar(styles, "--chart-grid"),
    axis: readVar(styles, "--chart-axis"),
    danger: readVar(styles, "--danger-text"),
  };
}

/**
 * The theme is a class on `<html>`, set by the toggle and by the system
 * preference watcher alike, so observing that one attribute covers both
 * without the panel needing to know which changed it.
 */
export function useChartPalette(): ChartPalette {
  const [palette, setPalette] = useState<ChartPalette>(readPalette);

  useEffect(() => {
    const observer = new MutationObserver(() => setPalette(readPalette()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return palette;
}

/** Stable colour for a model across every chart on the page. */
export function seriesColor(palette: ChartPalette, index: number): string {
  return palette.series[index % palette.series.length];
}
