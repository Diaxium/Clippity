import type { ReactNode } from "react";
import { Loader2, ScanEye } from "lucide-react";

import { useOverlayStore } from "../state/overlayStore";

/** Vertical room (logical px) the floating label needs above a box.
 *  When the box's top is nearer the screen edge than this, the label
 *  flips below the box instead so it's never clipped off-screen. */
const LABEL_CLEARANCE_PX = 32;

/**
 * Object-mode affordances: every AI detection gets a faint outline so
 * the user can see what's clickable, the hovered one gets the full
 * accent treatment (fill + ring + a floating "name · confidence" label
 * parked OUTSIDE the box so it never covers the element), and a centered
 * status pill covers the detecting / no-results / error states. Renders
 * nothing in other modes.
 *
 * `pointer-events: none` — the overlay root owns the hit-testing
 * (`useObjectSelection`); this layer is pure visual feedback. Detection
 * rects are physical px (virtual-desktop origin) while the overlay lays
 * out in logical px, so each side is divided by `devicePixelRatio` —
 * the same convention as `WindowHighlight`.
 */
export function ObjectHighlights() {
  const mode = useOverlayStore((s) => s.mode);
  const objects = useOverlayStore((s) => s.objects);
  const hoveredIndex = useOverlayStore((s) => s.hoveredObjectIndex);
  const status = useOverlayStore((s) => s.objectsStatus);
  const error = useOverlayStore((s) => s.objectsError);

  if (mode !== "object") return null;

  const dpr = window.devicePixelRatio || 1;

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
      {/* All detections — a quiet outline so targets are discoverable
          without turning the desktop into confetti. */}
      {status === "ready" &&
        objects.map((obj, i) => {
          if (i === hoveredIndex) return null; // drawn below, on top
          return (
            <div
              key={i}
              className="absolute rounded-[4px]"
              style={{
                left: obj.rect.x / dpr,
                top: obj.rect.y / dpr,
                width: obj.rect.width / dpr,
                height: obj.rect.height / dpr,
                border:
                  "1px solid color-mix(in srgb, var(--color-accent) 55%, transparent)",
                background:
                  "color-mix(in srgb, var(--color-accent) 5%, transparent)",
              }}
            />
          );
        })}

      {/* Hovered detection — the click target. */}
      {status === "ready" &&
        hoveredIndex !== null &&
        objects[hoveredIndex] &&
        (() => {
          const obj = objects[hoveredIndex]!;
          const label = `${obj.label} · ${Math.round(obj.confidence * 100)}%`;
          const left = obj.rect.x / dpr;
          const top = obj.rect.y / dpr;
          const viewportW = window.innerWidth || 1;
          // Park the label OUTSIDE the box so it never covers the element
          // being captured: above by default, flipped below only when the
          // box hugs the top edge (no room for the label above).
          const below = top < LABEL_CLEARANCE_PX;
          // Anchor to the box's left, but grow leftward instead when the
          // box sits in the right of the screen, so a long name can't run
          // off the right edge.
          const anchorRight = left > viewportW * 0.6;
          return (
            <div
              className="absolute rounded-[6px]"
              style={{
                left,
                top,
                width: obj.rect.width / dpr,
                height: obj.rect.height / dpr,
                border: "2px solid var(--color-accent)",
                background:
                  "color-mix(in srgb, var(--color-accent) 14%, transparent)",
                boxShadow:
                  "0 0 0 1px color-mix(in srgb, var(--color-accent) 45%, transparent), var(--shadow-deep)",
                transition:
                  "left 60ms ease-out, top 60ms ease-out, width 60ms ease-out, height 60ms ease-out",
              }}
            >
              {/* Floating label — outside the box, full text (no clamp /
                  truncation), so the whole "name · confidence" reads. */}
              <span
                className="absolute whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium shadow-[var(--shadow-medium)]"
                style={{
                  ...(anchorRight ? { right: 0 } : { left: 0 }),
                  ...(below
                    ? { top: "calc(100% + 6px)" }
                    : { bottom: "calc(100% + 6px)" }),
                  background: "var(--color-accent)",
                  color: "var(--color-accent-ink)",
                }}
              >
                {label}
              </span>
            </div>
          );
        })()}

      {/* Status pill — detecting / empty / error. */}
      {status === "detecting" && (
        <StatusPill>
          <Loader2 size={14} strokeWidth={2.2} className="animate-spin" />
          Detecting objects…
        </StatusPill>
      )}
      {status === "ready" && objects.length === 0 && (
        <StatusPill>
          <ScanEye size={14} strokeWidth={2} />
          No objects detected — press Esc and try another mode.
        </StatusPill>
      )}
      {status === "error" && (
        <StatusPill>
          <ScanEye size={14} strokeWidth={2} />
          {error ?? "Object detection failed."}
        </StatusPill>
      )}
    </div>
  );
}

function StatusPill({ children }: { children: ReactNode }) {
  return (
    <div className="absolute left-1/2 top-[18%] -translate-x-1/2">
      <span
        className="inline-flex max-w-[70vw] items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium text-white shadow-[var(--shadow-deep)]"
        style={{ background: "rgba(16,20,28,0.82)", backdropFilter: "blur(8px)" }}
      >
        {children}
      </span>
    </div>
  );
}
