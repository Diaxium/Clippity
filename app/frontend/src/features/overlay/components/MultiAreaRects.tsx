import { rectFromPoints } from "../geometry";
import { useOverlayStore } from "../state/overlayStore";

/**
 * Renders the committed Multi-Area rectangles (numbered accent outlines)
 * plus the in-progress drag rect (dashed). Pointer-transparent; the
 * canvas-wide handlers own input. Self-subscribes so a pointer-move only
 * re-renders this layer.
 */
export function MultiAreaRects() {
  const areas = useOverlayStore((s) => s.areas);
  const start = useOverlayStore((s) => s.start);
  const cur = useOverlayStore((s) => s.cur);
  const phase = useOverlayStore((s) => s.phase);

  const live =
    phase === "dragging" && start && cur ? rectFromPoints(start, cur) : null;

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
      {areas.map((r, i) => (
        <div
          key={`${r.x}:${r.y}:${r.w}:${r.h}`}
          className="absolute rounded-[3px] border-[1.5px] border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/12"
          style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        >
          <span className="absolute left-0 top-0 grid h-5 min-w-5 place-items-center rounded-br-[6px] bg-[color:var(--color-accent)] px-1 text-[11px] font-semibold text-[var(--color-accent-ink)]">
            {i + 1}
          </span>
        </div>
      ))}
      {live && (
        <div
          className="absolute rounded-[3px] border-[1.5px] border-dashed border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/8"
          style={{ left: live.x, top: live.y, width: live.w, height: live.h }}
        />
      )}
    </div>
  );
}
