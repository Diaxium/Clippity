import { useOverlayStore } from "../state/overlayStore";

/**
 * Window-mode affordance: a soft accent fill + ring over the window
 * under the cursor, with a title chip in its top-left corner. Renders
 * nothing in other modes or over bare desktop.
 *
 * `pointer-events: none` — the overlay root owns the hit-testing
 * (`useWindowSelection`); this layer is pure visual feedback. Window
 * rects are physical px (virtual-desktop origin) while the overlay lays
 * out in logical px, so each side is divided by `devicePixelRatio`. The
 * chip sits *inside* the top-left corner (rather than floating above)
 * so it never clips when a window is flush with the top of the screen.
 */
export function WindowHighlight() {
  const mode = useOverlayStore((s) => s.mode);
  const windows = useOverlayStore((s) => s.windows);
  const hoveredWindowId = useOverlayStore((s) => s.hoveredWindowId);

  if (mode !== "window") return null;
  const hovered = windows.find((w) => w.id === hoveredWindowId);
  if (!hovered) return null;

  const dpr = window.devicePixelRatio || 1;
  const left = hovered.rect.x / dpr;
  const top = hovered.rect.y / dpr;
  const width = hovered.rect.width / dpr;
  const height = hovered.rect.height / dpr;
  const label = hovered.app
    ? `${hovered.app} — ${hovered.title}`
    : hovered.title;

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
      <div
        className="absolute rounded-[6px]"
        style={{
          left,
          top,
          width,
          height,
          border: "2px solid var(--color-accent)",
          background:
            "color-mix(in srgb, var(--color-accent) 14%, transparent)",
          boxShadow:
            "0 0 0 1px color-mix(in srgb, var(--color-accent) 45%, transparent), var(--shadow-deep)",
          // Ease between windows so hovering across overlapping frames
          // glides instead of snapping (matches the overlay's polish).
          transition:
            "left 70ms ease-out, top 70ms ease-out, width 70ms ease-out, height 70ms ease-out",
        }}
      >
        <span
          className="absolute left-0 top-0 max-w-full truncate rounded-tl-[5px] rounded-br-md px-2 py-1 text-[12px] font-medium"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-ink)",
          }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}
