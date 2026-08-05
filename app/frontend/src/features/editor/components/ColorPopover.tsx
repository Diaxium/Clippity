import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { X } from "lucide-react";

import type { EntryRef } from "../lib/multi";
import { useEditorStore } from "../state/editorStore";
import { ColorPicker } from "./fields/ColorPicker";
import { FillPicker } from "./fields/FillPicker";

const WIDTH = 248;
const MARGIN = 8; // keep clear of the viewport edges

/** Top-left that centers the `WIDTH`×`h` editor over the canvas region (between
 *  the panels), so it floats over the artwork rather than crowding the
 *  right-hand inspector. Falls back to the viewport center when the canvas area
 *  can't be measured. */
function canvasCenter(h: number): { left: number; top: number } {
  const area = document
    .querySelector("[data-canvas-area]")
    ?.getBoundingClientRect();
  const cx = area ? area.left + area.width / 2 : window.innerWidth / 2;
  const cy = area ? area.top + area.height / 2 : window.innerHeight / 2;
  return { left: cx - WIDTH / 2, top: cy - h / 2 };
}

/** Clamp a desired top-left so the `WIDTH`×`h` popover stays fully inside the
 *  viewport (minus `MARGIN`). Idempotent — re-clamping an in-view box is a
 *  no-op, so it's safe to run repeatedly as the content resizes. */
function clampToView(
  left: number,
  top: number,
  h: number
): { left: number; top: number } {
  return {
    left: Math.max(MARGIN, Math.min(left, window.innerWidth - WIDTH - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN)),
  };
}

/**
 * Figma-style floating color editor. Opened from a panel row (`openColorEditor`)
 * with a screen anchor; opens centered over the canvas (clear of the
 * inspector), draggable by its header, and closes on outside-press or Escape.
 * Mounted once at the layout level so it floats over the canvas. FE1 hosts the
 * Fill editor; stroke / effect / text targets follow in FE3.
 *
 * **Multi-select (P3):** the popover *reads* the primary target — one swatch,
 * one gradient, one set of stops — but *writes* to the primary plus
 * `colorEditor.peers`, the same-row entries on the rest of the selection
 * (resolved by `lib/multi.entriesAt` at open time). Opening the fill editor with
 * three shapes selected therefore paints all three.
 */
export function ColorPopover() {
  const editor = useEditorStore((s) => s.colorEditor);
  const nodes = useEditorStore((s) => s.nodes);
  const close = useEditorStore((s) => s.closeColorEditor);
  const updateFills = useEditorStore((s) => s.updateFills);
  const updateStrokes = useEditorStore((s) => s.updateStrokes);
  const updateEffects = useEditorStore((s) => s.updateEffects);
  const updateNodes = useEditorStore((s) => s.updateNodes);

  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingFill = useRef<string | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Cap the popover to the viewport so a tall fill (gradient with many stops,
  // an expanded picker) scrolls its body instead of overflowing off-screen.
  const [maxH, setMaxH] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerHeight - 2 * MARGIN
  );

  // Open centered over the canvas (clear of the inspector), clamped into the
  // viewport. Draggable from there.
  useLayoutEffect(() => {
    if (!editor) {
      setPos(null);
      return;
    }
    setMaxH(window.innerHeight - 2 * MARGIN);
    const h = ref.current?.getBoundingClientRect().height ?? 0;
    const c = canvasCenter(h);
    setPos(clampToView(c.left, c.top, h));
  }, [editor]);

  // Keep the popover on-screen as its content grows/shrinks (solid → gradient,
  // expanding a stop's color picker, …) or the window resizes. Without this the
  // position is computed once at open time and a later-grown menu slips past the
  // bottom edge and clips. Preserves any dragged position; only nudges it back
  // into view.
  useEffect(() => {
    if (!editor) return;
    const el = ref.current;
    if (!el) return;
    const reflow = (): void => {
      setMaxH(window.innerHeight - 2 * MARGIN);
      setPos((p) =>
        p ? clampToView(p.left, p.top, el.getBoundingClientRect().height) : p
      );
    };
    const ro = new ResizeObserver(reflow);
    ro.observe(el);
    window.addEventListener("resize", reflow);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", reflow);
    };
  }, [editor]);

  // Close on outside press (but not the on-canvas gradient handles) or Escape.
  useEffect(() => {
    if (!editor) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t)) return;
      if (t?.closest?.("[data-grad]")) return; // a gradient handle on the canvas
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [editor, close]);

  if (!editor) return null;
  const target = editor.target;
  const node = nodes[target.nodeId];
  if (!node) return null;

  /**
   * The primary's entry plus every peer's — what the plural store actions take,
   * landing the whole batch as one undo step. Peers always share the primary's
   * `kind` (they come from the same row of the same list), so the entry-id field
   * is read off whichever discriminant this target carries.
   */
  const entryRefs = (entryId: string): EntryRef[] => [
    { nodeId: target.nodeId, entryId },
    ...editor.peers.map((p) => ({
      nodeId: p.nodeId,
      entryId:
        p.kind === "fill"
          ? p.fillId
          : p.kind === "stroke"
            ? p.strokeId
            : p.kind === "effect"
              ? p.effectId
              : "",
    })),
  ];
  /** Every node the edit lands on — for `text`, which has no entry list. */
  const nodeIds = (): string[] => [
    target.nodeId,
    ...editor.peers.map((p) => p.nodeId),
  ];

  const onHeaderDown = (e: ReactPointerEvent): void => {
    if (!pos) return;
    // Safety net for any control in the header (the close button already stops
    // its own pointerdown): never start a drag from a button press.
    if ((e.target as Element).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top };
  };
  const onHeaderMove = (e: ReactPointerEvent): void => {
    if (!drag.current) return;
    setPos({
      left: Math.max(
        MARGIN,
        Math.min(
          e.clientX - drag.current.dx,
          window.innerWidth - WIDTH - MARGIN
        )
      ),
      top: Math.max(MARGIN, e.clientY - drag.current.dy),
    });
  };
  const onHeaderUp = (): void => {
    drag.current = null;
  };

  const pickImage = (fillId: string): void => {
    pendingFill.current = fillId;
    fileRef.current?.click();
  };
  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const fillId = pendingFill.current;
    if (!file || !fillId || target.kind !== "fill") return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === "string" ? reader.result : "";
      if (src) updateFills(entryRefs(fillId), { type: "image", src });
    };
    reader.readAsDataURL(file);
  };

  let title = "Color";
  let body: ReactNode = null;
  if (target.kind === "fill") {
    const fill = node.fills.find((f) => f.id === target.fillId);
    if (!fill) return null;
    title = "Fill";
    body = (
      <FillPicker
        bare
        paint={fill}
        onChange={(patch) => updateFills(entryRefs(target.fillId), patch)}
        onPickImage={() => pickImage(target.fillId)}
      />
    );
  } else if (target.kind === "stroke") {
    const stroke = node.strokes.find((s) => s.id === target.strokeId);
    if (!stroke) return null;
    title = "Stroke";
    body = (
      <div className="p-2">
        <ColorPicker
          color={stroke.color}
          opacity={stroke.opacity}
          onChange={(color, opacity) =>
            updateStrokes(entryRefs(target.strokeId), { color, opacity })
          }
        />
      </div>
    );
  } else if (target.kind === "effect") {
    const fx = node.effects.find((e) => e.id === target.effectId);
    if (!fx) return null;
    title = "Effect color";
    body = (
      <div className="p-2">
        <ColorPicker
          color={fx.color}
          opacity={fx.opacity}
          onChange={(color, opacity) =>
            updateEffects(entryRefs(target.effectId), { color, opacity })
          }
        />
      </div>
    );
  } else if (target.kind === "text" && node.type === "text") {
    title = "Text color";
    body = (
      <div className="p-2">
        <ColorPicker
          color={node.color}
          opacity={1}
          onChange={(color) => updateNodes(nodeIds(), { color })}
        />
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="no-drag fixed z-[61] flex flex-col overflow-hidden rounded-[10px] border border-[color:var(--ed-hairline-strong)] bg-[var(--ed-panel)]"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: WIDTH,
        maxHeight: maxH || undefined,
        boxShadow: "var(--shadow-elevated)",
      }}
    >
      <div
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        className="flex h-8 shrink-0 cursor-grab items-center justify-between border-b border-[color:var(--ed-hairline)] px-2.5 active:cursor-grabbing"
      >
        <span className="text-[12px] font-medium text-[var(--ed-text)]">
          {title}
        </span>
        <button
          type="button"
          aria-label="Close color editor"
          // Swallow the pointerdown so the header's drag handler never captures
          // it — capture would retarget the click to the header and the button's
          // onClick would never fire (so the X would appear dead).
          onPointerDown={(e) => e.stopPropagation()}
          onClick={close}
          className="flex h-5 w-5 items-center justify-center rounded-[4px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFile}
      />
    </div>
  );
}
