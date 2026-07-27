import { AlertTriangle } from "lucide-react";

/**
 * Error-variant toast body — surfaces a failure message from the
 * capture / overlay pipelines (and, eventually, every other
 * port).
 *
 * Color design: uses the existing `--color-accent` family rather than
 * a dedicated error token. Clippity's accent is already a warm
 * coral that reads as "notable" — adding a separate error token
 * just for one toast variant would be design-system churn. The
 * legacy's rose-100/600 hex literals broke the rebuild's design-
 * token rule.
 */
export function ErrorToastBody({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-center gap-3.5 pr-14">
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[12px] bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]">
        <AlertTriangle size={20} strokeWidth={1.85} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-hint)]">
          Capture failed
        </span>
        <span className="text-[12.5px] leading-snug text-[var(--color-slate)]">
          {message}
        </span>
      </div>
    </div>
  );
}
