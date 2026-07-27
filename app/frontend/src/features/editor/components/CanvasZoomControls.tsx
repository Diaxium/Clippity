import { useEffect, useRef, useState } from "react";

import {
  Check,
  ChevronDown,
  Grid3x3,
  Magnet,
  Minus,
  MoreHorizontal,
  Plus,
} from "lucide-react";

import { cn } from "@shared/lib/cn";

import { clampZoom } from "../geometry";
import { useEditorStore } from "../state/editorStore";

const PRESETS = [0.5, 1, 2] as const;

/**
 * Canvas view cluster, pinned bottom-centre:
 * `−  [NN%▾]  +  │  Fit  ⊞ Grid  🧲 Snap  ⋯`.
 *
 * The percent is free-form (type any value, Enter; clamped to the zoom range)
 * with a caret for quick presets. Grid and snapping are direct toggles rather
 * than menu items — they're flipped mid-gesture often enough that a two-click
 * popover was the wrong shape for them. Rulers and re-centre stay in the
 * overflow, where a once-a-session control belongs.
 *
 * Floating surface built from app tokens — no new palette.
 */
export function CanvasZoomControls() {
  const zoom = useEditorStore((s) => s.viewport.zoom);
  const zoomIn = useEditorStore((s) => s.zoomIn);
  const zoomOut = useEditorStore((s) => s.zoomOut);
  const setZoom = useEditorStore((s) => s.setZoom);
  const fitView = useEditorStore((s) => s.fitView);
  const centerView = useEditorStore((s) => s.centerView);
  const showGrid = useEditorStore((s) => s.showGrid);
  const toggleGrid = useEditorStore((s) => s.toggleGrid);
  const showRulers = useEditorStore((s) => s.showRulers);
  const toggleRulers = useEditorStore((s) => s.toggleRulers);
  const snapEnabled = useEditorStore((s) => s.snapEnabled);
  const toggleSnap = useEditorStore((s) => s.toggleSnap);

  // At most one popover open at a time.
  const [menu, setMenu] = useState<"zoom" | "view" | null>(null);
  // While the user is typing, `draft` holds the in-progress text; null = idle.
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  const percent = Math.round(zoom * 100);

  const commitDraft = () => {
    if (draft === null) return;
    const parsed = parseFloat(draft.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) setZoom(clampZoom(parsed / 100));
    setDraft(null);
  };

  const iconBtn =
    "flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]";
  /** Icon + word toggle. Reads as pressed via the neutral raised slab, the same
   *  language the top bar uses for the active tool. */
  const toggleBtn = (on: boolean) =>
    cn(
      "flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[12px] font-medium",
      on
        ? "bg-[var(--ed-active-bg)] text-[var(--ed-active-text)]"
        : "text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
    );

  return (
    <div
      ref={ref}
      className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-[var(--radius-md)] border border-[color:var(--ed-hairline-strong)] p-1"
      style={{
        background: "var(--float-bg)",
        boxShadow: "var(--shadow-medium)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => zoomOut()}
        className={iconBtn}
      >
        <Minus size={15} strokeWidth={2} />
      </button>

      <div className="relative flex items-center rounded-[6px] hover:bg-[var(--ed-elev)]">
        <input
          ref={inputRef}
          aria-label="Zoom percent"
          inputMode="numeric"
          value={draft ?? `${percent}`}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => {
            setDraft(`${percent}`);
            e.target.select();
          }}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitDraft();
              inputRef.current?.blur();
            } else if (e.key === "Escape") {
              setDraft(null);
              inputRef.current?.blur();
            }
          }}
          className="h-7 w-9 bg-transparent pl-1.5 text-right text-[12px] font-medium tabular-nums text-[var(--ed-text)] outline-none"
        />
        <span className="pointer-events-none pr-0.5 text-[12px] font-medium text-[var(--ed-text)]">
          %
        </span>
        <button
          type="button"
          title="Zoom options"
          aria-label="Zoom presets"
          aria-haspopup="menu"
          aria-expanded={menu === "zoom"}
          onClick={() => setMenu((m) => (m === "zoom" ? null : "zoom"))}
          className="flex h-7 w-4 items-center justify-center rounded-r-[6px] text-[var(--ed-text-dim)] hover:text-[var(--ed-text)]"
        >
          <ChevronDown size={13} />
        </button>
        {menu === "zoom" && (
          <div
            role="menu"
            className="absolute bottom-full right-0 mb-1 min-w-[120px] rounded-[8px] border border-[color:var(--ed-hairline-strong)] p-1"
            style={{
              background: "var(--float-bg)",
              boxShadow: "var(--shadow-elevated)",
            }}
          >
            {PRESETS.map((p) => (
              <PresetItem
                key={p}
                label={`${p * 100}%`}
                active={percent === p * 100}
                onClick={() => {
                  setZoom(p);
                  setMenu(null);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => zoomIn()}
        className={iconBtn}
      >
        <Plus size={15} strokeWidth={2} />
      </button>

      <div className="mx-1 h-4 w-px bg-[var(--ed-hairline)]" />

      <button
        type="button"
        title="Zoom to fit (Shift 1)"
        onClick={() => fitView()}
        className="h-7 rounded-[6px] px-2 text-[12px] font-medium text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
      >
        Fit
      </button>

      <button
        type="button"
        aria-pressed={showGrid}
        title="Show grid"
        onClick={() => toggleGrid()}
        className={toggleBtn(showGrid)}
      >
        <Grid3x3 size={14} strokeWidth={1.75} />
        Grid
      </button>

      <button
        type="button"
        aria-pressed={snapEnabled}
        title="Snap to objects"
        onClick={() => toggleSnap()}
        className={toggleBtn(snapEnabled)}
      >
        <Magnet size={14} strokeWidth={1.75} />
        Snap
      </button>

      <div className="relative">
        <button
          type="button"
          aria-label="View options"
          title="View options"
          aria-haspopup="menu"
          aria-expanded={menu === "view"}
          onClick={() => setMenu((m) => (m === "view" ? null : "view"))}
          className={cn(
            iconBtn,
            menu === "view" && "bg-[var(--ed-elev)] text-[var(--ed-text)]"
          )}
        >
          <MoreHorizontal size={15} strokeWidth={1.75} />
        </button>
        {menu === "view" && (
          <div
            role="menu"
            className="absolute bottom-full right-0 mb-1 min-w-[180px] rounded-[8px] border border-[color:var(--ed-hairline-strong)] p-1"
            style={{
              background: "var(--float-bg)",
              boxShadow: "var(--shadow-elevated)",
            }}
          >
            <ToggleItem
              label="Show rulers"
              checked={showRulers}
              onClick={toggleRulers}
            />
            <PresetItem
              label="Center view"
              onClick={() => {
                centerView();
                setMenu(null);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function PresetItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex h-7 w-full items-center rounded-[5px] px-2 text-[12px]",
        active ? "text-[var(--ed-text)]" : "text-[var(--ed-text-dim)]",
        "hover:bg-[var(--ed-elev-hover)] hover:text-[var(--ed-text)]"
      )}
    >
      {label}
    </button>
  );
}

function ToggleItem({
  label,
  checked,
  onClick,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
      className="flex h-7 w-full items-center gap-2 rounded-[5px] px-2 text-[12px] text-[var(--ed-text)] hover:bg-[var(--ed-elev-hover)]"
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--ed-accent)]">
        {checked && <Check size={13} strokeWidth={2.5} />}
      </span>
      <span className="flex-1 text-left">{label}</span>
    </button>
  );
}
