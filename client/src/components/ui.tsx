import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

const fieldClass =
  "min-h-11 w-full rounded-lg border border-line bg-surface px-4 text-base text-text outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--ring)]";

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "accent" | "ghost" }) {
  const styles = {
    primary: "bg-primary text-on-primary hover:bg-primary-hover",
    accent: "bg-accent text-on-accent hover:brightness-110",
    ghost: "border border-line bg-surface text-text hover:bg-surface-2",
  }[variant];
  return (
    <button
      className={`inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-semibold focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--ring)] active:motion-safe:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function TextField({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = props.id || props.name;
  return (
    <label className="block text-sm font-semibold" htmlFor={id}>
      {label}
      <input id={id} className={`mt-2 ${fieldClass}`} {...props} />
    </label>
  );
}

export function SelectField({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  const id = props.id || props.name;
  return (
    <label className="block text-sm font-semibold" htmlFor={id}>
      {label}
      <select id={id} className={`mt-2 ${fieldClass}`} {...props}>
        {children}
      </select>
    </label>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-lg border px-4 py-3 text-sm"
      role="alert"
      style={{
        background: "var(--danger-bg)",
        borderColor: "var(--danger)",
        color: "var(--danger)",
      }}
    >
      {children}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-line bg-surface p-6 ${className}`}>{children}</section>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "available"
      ? "var(--success)"
      : status === "failed"
        ? "var(--danger)"
        : status === "processing"
          ? "var(--info)"
          : "var(--warning)";
  const background =
    status === "available"
      ? "var(--success-bg)"
      : status === "failed"
        ? "var(--danger-bg)"
        : status === "processing"
          ? "var(--info-bg)"
          : "var(--warning-bg)";
  return (
    <span
      className="inline-flex min-h-8 items-center rounded-full px-3 text-xs font-semibold capitalize"
      style={{ color: tone, background }}
    >
      {status}
    </span>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      <button aria-label="Close dialog" className="absolute inset-0 bg-slate-950/60" onClick={onClose} />
      <div
        aria-modal="true"
        className="relative z-10 w-full max-w-md rounded-xl border border-line bg-surface p-6 shadow-xl"
        role="dialog"
      >
        <h2 className="text-xl font-semibold">{title}</h2>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
