import { HelpCircle } from "lucide-react";

import type { ToastKind } from "../types";

/**
 * Fallback body for reserved toast variants that haven't been ported
 * yet. The backend rejects non-Error variants with
 * `AppError::Unsupported`, so this component should normally never
 * render. It exists so that:
 *
 * - dev-mode emits via devtools / test harnesses surface visibly
 *   instead of producing an empty toast,
 * - reviewers spot the gap during a manual driving session.
 *
 * Each owning port (e.g. Color-Pick) flips its `case` in `modes.tsx`
 * from `default → UnknownKindBody` to a real per-kind body component
 * when it lands.
 */
export function UnknownKindBody({ kind }: { kind: ToastKind }) {
  return (
    <div className="flex items-center gap-3.5 pr-14">
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[12px] bg-[color:var(--color-overlay-2)] text-[var(--color-hint)]">
        <HelpCircle size={20} strokeWidth={1.85} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-hint)]">
          Reserved kind
        </span>
        <span className="font-mono text-[12px] text-[var(--color-slate)]">
          {kind}
        </span>
      </div>
    </div>
  );
}
