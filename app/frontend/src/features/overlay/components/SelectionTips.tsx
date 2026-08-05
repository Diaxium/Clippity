import { Fragment } from "react";
import { Keyboard } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { cn } from "@shared/lib/cn";

import { useOverlayStore } from "../state/overlayStore";
import type { OverlayMode, Phase } from "../types";

export interface SelectionTip {
  keys: string[];
  label: string;
}

const HELP_TIP: SelectionTip = { keys: ["?"], label: "All shortcuts" };
const CANCEL_TIP: SelectionTip = { keys: ["Esc"], label: "Cancel" };

function rectTips(phase: Phase, commitLabel: string): SelectionTip[] {
  if (phase === "selected") {
    return [
      { keys: ["Enter"], label: commitLabel },
      { keys: ["Arrows"], label: "Nudge 1 px" },
      { keys: ["Shift", "Arrows"], label: "Nudge 10 px" },
      { keys: ["Alt", "Arrows"], label: "Resize" },
      HELP_TIP,
    ];
  }

  if (phase === "dragging") {
    return [
      { keys: ["Shift"], label: "Square" },
      { keys: ["Alt"], label: "Precision" },
      CANCEL_TIP,
      HELP_TIP,
    ];
  }

  return [
    { keys: ["Shift"], label: "Square" },
    { keys: ["Alt"], label: "Precision" },
    { keys: ["L"], label: "Last region" },
    HELP_TIP,
  ];
}

export function selectionTipsFor(
  mode: OverlayMode,
  phase: Phase
): SelectionTip[] {
  switch (mode) {
    case "region":
    case "palette":
      return rectTips(
        phase,
        mode === "palette" ? "Extract palette" : "Capture"
      );
    case "grab-text":
      return rectTips(phase, "Grab text");
    case "scrolling":
      return rectTips(phase, "Record");
    case "panoramic":
      return rectTips(phase, "Start");
    case "record-region":
      return rectTips(phase, "Record");
    case "multi-area":
      return [
        { keys: ["Drag"], label: "Add area" },
        { keys: ["Shift"], label: "Square" },
        { keys: ["Backspace"], label: "Undo area" },
        { keys: ["Enter"], label: "Capture" },
        HELP_TIP,
      ];
    case "freehand":
      return phase === "selected"
        ? [
            { keys: ["Enter"], label: "Capture shape" },
            { keys: ["Drag"], label: "Redraw" },
            CANCEL_TIP,
            HELP_TIP,
          ]
        : [
            { keys: ["Drag"], label: "Draw shape" },
            { keys: ["Release"], label: "Close shape" },
            { keys: ["Enter"], label: "Capture" },
            HELP_TIP,
          ];
    case "pen":
      return phase === "selected"
        ? [
            { keys: ["Enter"], label: "Capture path" },
            { keys: ["Backspace"], label: "Remove anchor" },
            CANCEL_TIP,
            HELP_TIP,
          ]
        : [
            { keys: ["Click"], label: "Add anchor" },
            { keys: ["Drag"], label: "Curve handle" },
            { keys: ["Alt", "Drag"], label: "Cusp" },
            { keys: ["Enter"], label: "Close path" },
            HELP_TIP,
          ];
    case "magnetic-lasso":
      return [
        { keys: ["Drag"], label: "Trace edges" },
        { keys: ["Release"], label: "Close trace" },
        { keys: ["Enter"], label: "Capture" },
        HELP_TIP,
      ];
    case "brush":
      return [
        { keys: ["Drag"], label: "Paint" },
        { keys: ["Alt", "Drag"], label: "Erase" },
        { keys: ["Wheel"], label: "Brush size" },
        { keys: ["Enter"], label: "Capture" },
        HELP_TIP,
      ];
    case "window":
    case "record-window":
      return [
        {
          keys: ["Click"],
          label: mode === "record-window" ? "Record window" : "Capture window",
        },
        { keys: ["Enter"], label: "Use hovered" },
        { keys: ["R"], label: "Region mode" },
        HELP_TIP,
      ];
    case "object":
      return [
        { keys: ["Click"], label: "Capture object" },
        { keys: ["Enter"], label: "Use hovered" },
        CANCEL_TIP,
        HELP_TIP,
      ];
    case "color-pick":
      return [{ keys: ["Click"], label: "Copy color" }, CANCEL_TIP, HELP_TIP];
    default:
      return [CANCEL_TIP, HELP_TIP];
  }
}

export function SelectionTips() {
  const mode = useOverlayStore((s) => s.mode);
  const phase = useOverlayStore((s) => s.phase);
  const helpOpen = useOverlayStore((s) => s.helpOpen);
  const tips = selectionTipsFor(mode, phase);
  const topBannerVisible = phase === "empty" || phase === "idle";

  return (
    <AnimatePresence>
      {!helpOpen && tips.length > 0 && (
        <motion.div
          key={`${mode}-${phase}-tips`}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          aria-label="Selection tips"
          className={cn(
            "pointer-events-none absolute left-1/2 z-20 max-w-[calc(100vw-32px)] -translate-x-1/2",
            topBannerVisible ? "top-[78px]" : "top-7"
          )}
        >
          <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-[14px] border border-white/15 bg-black/45 px-2.5 py-2 text-[11.5px] font-medium text-white/88 shadow-[var(--shadow-medium)] backdrop-blur-md">
            <span className="inline-flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-white/55">
              <Keyboard size={12} strokeWidth={1.9} />
              Tips
            </span>
            {tips.map((tip, index) => (
              <Fragment key={`${tip.label}-${index}`}>
                <TipChip tip={tip} />
                {index < tips.length - 1 && (
                  <span aria-hidden className="h-3 w-px bg-white/15" />
                )}
              </Fragment>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TipChip({ tip }: { tip: SelectionTip }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap px-1">
      <span className="inline-flex items-center gap-0.5">
        {tip.keys.map((key, index) => (
          <Fragment key={`${key}-${index}`}>
            {index > 0 && (
              <span aria-hidden className="px-0.5 text-white/35">
                +
              </span>
            )}
            <kbd className="rounded-[5px] border border-white/20 bg-white/12 px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none text-white">
              {key}
            </kbd>
          </Fragment>
        ))}
      </span>
      <span className="text-white/78">{tip.label}</span>
    </span>
  );
}
