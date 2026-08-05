/**
 * Small presentational parts shared by the developer panels.
 *
 * They live here rather than in `shared/ui` because their job is
 * specific to a diagnostics surface: dense key/value readouts, a
 * copy-with-feedback button, and a destructive action that asks first.
 * Promoting them would mean designing for callers that don't exist.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";

import { cn } from "@shared/lib/cn";
import { Button } from "@shared/ui";

/** A dense `label · value` line, for the readout cards. */
export function StatLine({
  label,
  value,
  mono = true,
  tone = "normal",
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  tone?: "normal" | "warn" | "good";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-5 py-1.5">
      <span className="shrink-0 text-[12px] text-[var(--color-slate)]">
        {label}
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-right text-[12px]",
          mono && "font-mono",
          tone === "warn" && "text-[var(--color-accent)]",
          tone === "good" && "text-[var(--color-ink)]",
          tone === "normal" && "text-[var(--color-ink)]"
        )}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}

/** A row of actions inside a section card. */
export function ActionRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-[var(--color-ink)]">
          {label}
        </p>
        {description && (
          <p className="mt-0.5 text-[12px] text-[var(--color-slate)]">
            {description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * Copy `text()` to the clipboard, then say so for a moment.
 *
 * `text` is a function rather than a string so the caller can build a
 * multi-kilobyte summary at click time instead of on every render of a
 * page that mostly isn't being copied from.
 */
export function CopyButton({
  text,
  label = "Copy",
  size = "sm",
  disabled = false,
}: {
  text: () => string;
  label?: string;
  size?: "sm" | "md";
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(text()).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      },
      () => {
        /* clipboard refused — the button simply doesn't confirm */
      }
    );
  }, [text]);

  return (
    <Button variant="secondary" size={size} onClick={copy} disabled={disabled}>
      {copied ? (
        <Check size={13} strokeWidth={2} />
      ) : (
        <Copy size={13} strokeWidth={2} />
      )}
      {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * A destructive action that states exactly what goes before it runs.
 *
 * `confirm` mirrors `developer.confirmDestructive`: when the user has
 * turned that off, the first click acts. When it is on, the first click
 * arms and the label becomes the consequence — a two-step that costs a
 * click and has saved a library index more than once.
 */
export function DangerButton({
  label,
  confirmLabel,
  confirm,
  onConfirm,
  disabled = false,
}: {
  label: string;
  /** What will be removed — shown on the armed button. */
  confirmLabel: string;
  confirm: boolean;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  // Disarm on its own: a button left armed behind a scroll is a trap
  // for the next click that lands near it.
  const arm = () => {
    setArmed(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setArmed(false), 5000);
  };

  if (!confirm) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={onConfirm}
        disabled={disabled}
      >
        {label}
      </Button>
    );
  }

  return armed ? (
    <Button
      variant="danger"
      size="sm"
      disabled={disabled}
      onClick={() => {
        setArmed(false);
        onConfirm();
      }}
    >
      <AlertTriangle size={13} strokeWidth={2} />
      {confirmLabel}
    </Button>
  ) : (
    <Button variant="secondary" size="sm" onClick={arm} disabled={disabled}>
      {label}
    </Button>
  );
}

/** A short status note under a row — the result of the last action. */
export function ResultNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="px-5 pb-3 text-[12px] text-[var(--color-slate)]">
      {children}
    </p>
  );
}
