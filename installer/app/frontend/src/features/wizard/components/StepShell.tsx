import type { ReactNode } from "react";

import { cn } from "@shared/lib/cn";

interface StepShellProps {
  /** Large step heading. */
  title: string;
  /** One-line description under the heading. */
  subtitle?: string;
  /** Optional element rendered at the top-right of the header row. */
  headerAside?: ReactNode;
  /** The step body (scrolls if it overflows). */
  children: ReactNode;
  /** Right-aligned footer actions (Back / Next / primary). */
  footer?: ReactNode;
  /** Left-aligned footer slot (e.g. "View log", a confirm toggle). */
  footerLeft?: ReactNode;
  className?: string;
}

/**
 * The standard step layout: a header (title + subtitle), a scrollable
 * body, and a footer bar. Hero-style steps (Welcome / Complete) opt out
 * and lay themselves out instead.
 */
export function StepShell({
  title,
  subtitle,
  headerAside,
  children,
  footer,
  footerLeft,
  className,
}: StepShellProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-3 px-7 pt-6 pb-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[19px] font-semibold tracking-tight text-[var(--color-ink)]">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1 text-[13px] text-[var(--color-slate)]">
              {subtitle}
            </p>
          )}
        </div>
        {headerAside && <div className="shrink-0">{headerAside}</div>}
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto px-7", className)}>
        {children}
      </div>

      {(footer || footerLeft) && (
        <div className="flex items-center gap-3 border-t border-[var(--hairline)] px-7 py-4">
          <div className="flex min-w-0 flex-1 items-center">{footerLeft}</div>
          <div className="flex items-center gap-2">{footer}</div>
        </div>
      )}
    </div>
  );
}
