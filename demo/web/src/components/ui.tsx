import type { ReactNode } from "react";

/** Native select with the app's dark styling. Native keeps it accessible. */
export function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="uppercase tracking-wider text-ink-500">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-ink-100 outline-none transition focus:border-gold-500"
      >
        {children}
      </select>
    </label>
  );
}

/** One measurement in a metrics strip: small caps label over a value. */
export function Stat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[0.625rem] uppercase tracking-wider text-ink-500">
        {label}
      </span>
      <span
        className={`font-mono text-xs ${accent ? "text-gold-500" : "text-ink-100"}`}
      >
        {value}
      </span>
    </div>
  );
}

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-ink-800 bg-ink-900 ${className}`}
    >
      {children}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-xl border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200"
    >
      {message}
    </p>
  );
}
