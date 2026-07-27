import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";

import type { OverlayMode } from "../types";
import { useOverlayStore } from "../state/overlayStore";

interface Binding {
  keys: string[];
  label: string;
  description?: string;
}

type BindingGroup = { title: string; items: Binding[] };

const GENERAL_GROUP: BindingGroup = {
  title: "General",
  items: [
    { keys: ["Esc"], label: "Cancel overlay" },
    { keys: ["?"], label: "Toggle this help", description: "Or press F1" },
  ],
};

const PEN_BINDINGS: BindingGroup[] = [
  GENERAL_GROUP,
  {
    title: "Build the path",
    items: [
      { keys: ["Click"], label: "Add a corner anchor" },
      {
        keys: ["Click", "Drag"],
        label: "Pull out curve handles",
        description: "Symmetric Bézier handles",
      },
      {
        keys: ["Alt", "Drag"],
        label: "Make a cusp",
        description: "Break the handle symmetry",
      },
    ],
  },
  {
    title: "Finish",
    items: [
      {
        keys: ["Enter"],
        label: "Close the path",
        description: "Or click the first anchor",
      },
      { keys: ["Backspace"], label: "Remove the last anchor" },
    ],
  },
];

const LASSO_BINDINGS: BindingGroup[] = [
  GENERAL_GROUP,
  {
    title: "Trace",
    items: [
      {
        keys: ["Drag"],
        label: "Trace around an object",
        description: "Clippity snaps to the nearest edges",
      },
    ],
  },
  {
    title: "Finish",
    items: [
      { keys: ["Release"], label: "Close the trace" },
      { keys: ["Enter"], label: "Capture the selection" },
    ],
  },
];

const BRUSH_BINDINGS: BindingGroup[] = [
  GENERAL_GROUP,
  {
    title: "Paint",
    items: [
      { keys: ["Drag"], label: "Paint over the area to capture" },
      {
        keys: ["Alt", "Drag"],
        label: "Erase from the mask",
        description: "Or flip the Add/Subtract toggle",
      },
      { keys: ["Wheel"], label: "Resize the brush" },
    ],
  },
  {
    title: "Finish",
    items: [{ keys: ["Enter"], label: "Capture the painted area" }],
  },
];

const FREEHAND_BINDINGS: BindingGroup[] = [
  GENERAL_GROUP,
  {
    title: "Draw",
    items: [
      { keys: ["Drag"], label: "Draw a freeform shape" },
      { keys: ["Release"], label: "Close the shape" },
    ],
  },
  {
    title: "Finish",
    items: [{ keys: ["Enter"], label: "Capture the selection" }],
  },
];

const REGION_BINDINGS: BindingGroup[] = [
  {
    title: "General",
    items: [
      { keys: ["Esc"], label: "Cancel overlay" },
      { keys: ["?"], label: "Toggle this help", description: "Or press F1" },
    ],
  },
  {
    title: "Confirm selection",
    items: [
      {
        keys: ["Enter"],
        label: "Capture the selected region",
        description: "After dragging out a rectangle",
      },
      {
        keys: ["L"],
        label: "Reuse the last region",
        description: "Same position and size as your previous capture",
      },
    ],
  },
  {
    title: "Drag",
    items: [
      {
        keys: ["Shift"],
        label: "Snap to a perfect square",
        description: "Hold while drawing a fresh rect",
      },
      {
        keys: ["Shift"],
        label: "Lock the aspect ratio",
        description: "Hold while dragging a resize handle",
      },
      {
        keys: ["Alt"],
        label: "Precision mode",
        description: "Pixel grid + tighter magnifier zoom",
      },
    ],
  },
  {
    title: "Fine adjustment",
    items: [
      {
        keys: ["Alt", "Move"],
        label: "Slow the cursor for pixel work",
        description: "Hold while drawing, moving, or resizing",
      },
      {
        keys: ["←", "→", "↑", "↓"],
        label: "Nudge selection by 1 px",
        description: "Hold Shift for 10 px",
      },
      {
        keys: ["Alt", "↑"],
        label: "Resize from bottom-right",
        description: "Alt + any arrow key",
      },
    ],
  },
];

/** The cheat-sheet groups for the active selection mode. Modes without a
 *  dedicated sheet (Rectangle, Window, …) fall back to the Region set. */
function bindingsFor(mode: OverlayMode): BindingGroup[] {
  switch (mode) {
    case "pen":
      return PEN_BINDINGS;
    case "magnetic-lasso":
      return LASSO_BINDINGS;
    case "brush":
      return BRUSH_BINDINGS;
    case "freehand":
      return FREEHAND_BINDINGS;
    default:
      return REGION_BINDINGS;
  }
}

/**
 * `?` / F1 cheat-sheet popover. Owns its own Esc to dismiss so the
 * outer Esc handler doesn't also cancel the overlay.
 */
export function KeybindHelp() {
  const open = useOverlayStore((s) => s.helpOpen);
  const setHelpOpen = useOverlayStore((s) => s.setHelpOpen);
  const mode = useOverlayStore((s) => s.mode);
  const groups = bindingsFor(mode);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setHelpOpen(false);
      }
    };
    // Capture phase so we beat the overlay-level Esc handler.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setHelpOpen]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="absolute inset-0 z-40 grid place-items-center bg-black/40"
          onPointerDown={(e) => {
            e.stopPropagation();
            setHelpOpen(false);
          }}
        >
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="w-[420px] rounded-2xl border border-[color:var(--hairline)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-elevated)]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">
                Keyboard shortcuts
              </h2>
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                aria-label="Close help"
                className="focus-ring grid h-7 w-7 place-items-center rounded-md text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
              >
                <X size={14} strokeWidth={1.85} />
              </button>
            </div>
            <div className="flex flex-col gap-4">
              {groups.map((g) => (
                <section key={g.title}>
                  <h3 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--color-hint)]">
                    {g.title}
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {g.items.map((b, i) => (
                      <li
                        key={`${g.title}-${i}`}
                        className="flex items-baseline gap-2.5 text-[12.5px]"
                      >
                        <span className="flex shrink-0 gap-1">
                          {b.keys.map((k) => (
                            <kbd
                              key={k}
                              className="rounded-md border border-[color:var(--hairline)] bg-[color:var(--color-overlay-1)] px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-[var(--color-ink)]"
                            >
                              {k}
                            </kbd>
                          ))}
                        </span>
                        <span className="text-[var(--color-ink)]">
                          {b.label}
                        </span>
                        {b.description && (
                          <span className="text-[var(--color-hint)]">
                            · {b.description}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
