import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Clipboard,
  Download,
  ExternalLink,
  FolderOpen,
  Link2,
  PenLine,
  ScanText,
  Share2,
} from "lucide-react";

import {
  finishGrabText,
  finishRegionCapture,
} from "@services/tauri/clients/overlay";
import type { OverlayToggles, Region } from "@services/tauri/clients/overlay";
import { shareCapture } from "@services/tauri/clients/share";
import type { ShareTarget } from "@services/tauri/clients/share";
import { emitErrorToast } from "@services/tauri/clients/toast";
import { cn } from "@shared/lib/cn";

import { CHROME_STOP_PROPS } from "../eventStops";
import { useOverlayStore } from "../state/overlayStore";

interface ActionDef {
  id: "copy" | "save" | "annotate" | "ocr" | "share";
  label: string;
  icon: ComponentType<{
    size?: number;
    strokeWidth?: number;
    className?: string;
  }>;
  /** How the action finishes:
   *  - `capture` — commit the selection with a toggle override.
   *  - `ocr` — read the text instead of saving an image.
   *  - `share` — open the target menu; the pick commits, then hands
   *    the saved file to the OS. */
  kind: "capture" | "ocr" | "share";
  /** Toggle overrides for `kind: "capture"`. Everything not named here
   *  keeps whatever the user set in the toolbar — Smart enhance and
   *  Capture cursor ride along on every action. */
  override?: Partial<OverlayToggles>;
}

const ACTIONS: readonly ActionDef[] = [
  {
    id: "copy",
    label: "Copy to clipboard",
    icon: Clipboard,
    kind: "capture",
    override: { clipboard: true, preview: false },
  },
  {
    id: "save",
    label: "Save image",
    icon: Download,
    kind: "capture",
    // Save and nothing else: no clipboard write, no editor.
    override: { clipboard: false, preview: false },
  },
  {
    id: "annotate",
    label: "Edit & annotate",
    icon: PenLine,
    kind: "capture",
    override: { preview: true },
  },
  {
    id: "ocr",
    label: "Extract text (OCR)",
    icon: ScanText,
    kind: "ocr",
  },
  {
    id: "share",
    label: "Share",
    icon: Share2,
    kind: "share",
  },
];

interface ShareOption {
  target: ShareTarget;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

const SHARE_OPTIONS: readonly ShareOption[] = [
  { target: "reveal", label: "Show in folder", icon: FolderOpen },
  { target: "open", label: "Open in default app", icon: ExternalLink },
  { target: "copy-path", label: "Copy file path", icon: Link2 },
];

/**
 * Contextual action bar — appears just outside the selection once it
 * commits, giving the user one-click access to common post-capture
 * actions without traveling all the way to the BottomToolbar.
 *
 * Positioning rules:
 *   - Default placement: 12 px below the selection's bottom edge.
 *   - If that overlaps the BottomToolbar reserve zone, flip above the
 *     top edge instead.
 *   - Horizontal: aligned to the rect's center, clamped into the
 *     viewport with a 14 px gutter.
 *
 * The bar is purely additive — the BottomToolbar still owns the
 * primary Capture CTA + mode switching.
 */
export function SelectionActionBar() {
  const phase = useOverlayStore((s) => s.phase);
  const rect = useOverlayStore((s) => s.rect);
  const toggles = useOverlayStore((s) => s.toggles);
  const cursorPin = useOverlayStore((s) => s.cursorPin);
  const reset = useOverlayStore((s) => s.reset);
  const fireCaptureFlash = useOverlayStore((s) => s.fireCaptureFlash);
  const [shareOpen, setShareOpen] = useState(false);
  const shareRef = useRef<HTMLDivElement | null>(null);

  // The menu is transient chrome: any click that isn't in it dismisses,
  // so it can never sit on top of a selection the user has moved on from.
  useEffect(() => {
    if (!shareOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!shareRef.current?.contains(e.target as Node)) setShareOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Swallow Escape so it closes the menu rather than the overlay.
      if (e.key === "Escape") {
        e.stopPropagation();
        setShareOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [shareOpen]);

  const visible = phase === "selected" && rect !== null;

  if (!visible || !rect) {
    return <AnimatePresence>{null}</AnimatePresence>;
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const BAR_HEIGHT = 44;
  const ESTIMATED_WIDTH = 250;
  const GUTTER = 12;
  const TOOLBAR_RESERVE = 80;

  // Default below the rect; flip above when below would collide with
  // the bottom-toolbar zone.
  let top = rect.y + rect.h + GUTTER;
  if (top + BAR_HEIGHT > vh - TOOLBAR_RESERVE) {
    top = rect.y - BAR_HEIGHT - GUTTER;
  }
  // If above also doesn't fit, tuck it just inside the rect's top edge.
  if (top < 14) {
    top = Math.max(rect.y + 8, 14);
  }
  const centerX = rect.x + rect.w / 2;
  let left = centerX - ESTIMATED_WIDTH / 2;
  left = Math.max(14, Math.min(vw - ESTIMATED_WIDTH - 14, left));

  const dpr = window.devicePixelRatio || 1;
  /** Logical-px selection → physical-px wire `Region` (the seam every
   *  overlay finalize scales at). */
  const wireRect = (): Region => ({
    x: Math.round(rect.x * dpr),
    y: Math.round(rect.y * dpr),
    width: Math.round(rect.w * dpr),
    height: Math.round(rect.h * dpr),
  });
  const fail = (err: unknown, fallback: string) => {
    void emitErrorToast(err instanceof Error ? err.message : fallback);
  };

  /** Commit the selection as a file. Resolves to the saved path so the
   *  share flow can act on it. */
  const commit = (override?: Partial<OverlayToggles>) => {
    fireCaptureFlash();
    return finishRegionCapture({
      rect: wireRect(),
      cursorPin: cursorPin
        ? [Math.round(cursorPin.x * dpr), Math.round(cursorPin.y * dpr)]
        : null,
      toggles: { ...toggles, ...override },
    });
  };

  const onAction = (a: ActionDef) => {
    if (a.kind === "share") {
      setShareOpen((open) => !open);
      return;
    }
    if (a.kind === "ocr") {
      fireCaptureFlash();
      // OCR produces a text library entry + a toast, not a file — the
      // backend closes the overlay and copies the text itself.
      finishGrabText(wireRect())
        .then(() => reset())
        .catch((err: unknown) => fail(err, "Could not read that region."));
      return;
    }
    commit(a.override)
      .then(() => reset())
      .catch((err: unknown) => fail(err, "Capture failed."));
  };

  const onShare = (target: ShareTarget) => {
    setShareOpen(false);
    // Share always saves first — there has to be a file to hand over —
    // but never opens the editor: the user asked to send it somewhere,
    // not to keep working on it.
    commit({ preview: false })
      .then((result) => shareCapture(result.path, target))
      .then(() => reset())
      .catch((err: unknown) => fail(err, "Could not share that capture."));
  };

  return (
    <AnimatePresence>
      <motion.div
        key="action-bar"
        initial={{ opacity: 0, y: 6, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.96 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        {...CHROME_STOP_PROPS}
        className="absolute z-20"
        style={{ left, top }}
        ref={shareRef}
      >
        <div
          className={cn(
            "flex items-center gap-0.5 rounded-[12px] border px-1 py-1 backdrop-blur-[10px]",
            "border-[color:var(--hairline)] bg-[var(--color-surface)]/88 shadow-[var(--shadow-medium)]"
          )}
        >
          {ACTIONS.map((a) => {
            const Icon = a.icon;
            const active = a.kind === "share" && shareOpen;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onAction(a)}
                title={a.label}
                aria-label={a.label}
                aria-expanded={a.kind === "share" ? shareOpen : undefined}
                className={cn(
                  "grid h-8 w-8 place-items-center rounded-[9px] transition-colors duration-150",
                  active
                    ? "bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]"
                    : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
                )}
              >
                <Icon size={14} strokeWidth={1.85} />
              </button>
            );
          })}
        </div>

        {shareOpen && (
          <div
            role="menu"
            className={cn(
              "absolute right-0 top-[46px] w-[190px] overflow-hidden rounded-[10px] border py-1 backdrop-blur-[10px]",
              "border-[color:var(--hairline)] bg-[var(--color-surface)]/95 shadow-[var(--shadow-deep)]"
            )}
          >
            {SHARE_OPTIONS.map((o) => {
              const Icon = o.icon;
              return (
                <button
                  key={o.target}
                  type="button"
                  role="menuitem"
                  onClick={() => onShare(o.target)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] font-medium",
                    "text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
                  )}
                >
                  <Icon size={13} strokeWidth={1.85} />
                  {o.label}
                </button>
              );
            })}
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
