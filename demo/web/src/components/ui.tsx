import type { ReactNode } from "react";

/** Native select in the app's theme tokens. Native keeps it accessible. */
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
      <span className="uppercase tracking-wider text-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-line-strong bg-inset px-2.5 py-1.5 text-sm text-body outline-none transition focus:border-accent"
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
      <span className="text-[0.625rem] uppercase tracking-wider text-muted">
        {label}
      </span>
      <span
        className={`font-mono text-xs ${accent ? "text-accent" : "text-body"}`}
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
    <div className={`rounded-2xl border border-line bg-surface ${className}`}>
      {children}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-xl border border-danger-line bg-danger-surface px-3 py-2 text-sm text-danger"
    >
      {message}
    </p>
  );
}
