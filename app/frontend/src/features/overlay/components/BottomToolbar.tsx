import type { ComponentType } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Clipboard,
  CornerDownLeft,
  Eye,
  History,
  MousePointer2,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

import {
  beginRegionCapture,
  cancelRegionCapture,
} from "@services/tauri/clients/overlay";
import { cn } from "@shared/lib/cn";
import { ScrollDirectionPicker } from "@shared/ui";

import { CHROME_STOP_PROPS } from "../eventStops";
import { isRegionMethod, SIDEBAR_ITEMS } from "../modes";
import { useOverlayStore } from "../state/overlayStore";
import { captureFullscreenFromOverlay } from "../hooks/fullscreenCapture";
import { useLastRegion } from "../hooks/useLastRegion";
import { useOverlayFinalize } from "../hooks/useOverlayFinalize";
import { RegionMethodMenu } from "./RegionMethodMenu";

/**
 * Bottom toolbar — visually calmer chrome that yields visual priority
 * to the capture region.
 *
 * Layout (left → right):
 *
 *   [ mode-tabs ]  ·  [ Capture CTA ]  ·  [ utility icons ]
 *
 *   Modes use a low-key pill row with a thin accent indicator under
 *   the active mode.
 *   Utilities (Preview / Clipboard / Cursor) are icon-only with hover
 *   tooltips; the entire group collapses while no selection exists.
 *   Cancel sits at the trailing edge as a quiet icon button.
 *
 * Reduced weight: smaller padding, lighter blur, dimmer hairline,
 * smaller icon size. The Capture button keeps its breathing ring
 * while a selection is ready to remain the visual focal point.
 */
export function BottomToolbar() {
  const mode = useOverlayStore((s) => s.mode);
  const toggles = useOverlayStore((s) => s.toggles);
  const setToggles = useOverlayStore((s) => s.setToggles);
  const scrollDirection = useOverlayStore((s) => s.scrollDirection);
  const setScrollDirection = useOverlayStore((s) => s.setScrollDirection);
  const reset = useOverlayStore((s) => s.reset);
  const areaCount = useOverlayStore((s) => s.areas.length);
  const phase = useOverlayStore((s) => s.phase);
  const penCount = useOverlayStore((s) => s.penPath.length);
  const popPenAnchor = useOverlayStore((s) => s.popPenAnchor);
  const closePen = useOverlayStore((s) => s.closePen);
  const brushSize = useOverlayStore((s) => s.brushSize);
  const brushModeVal = useOverlayStore((s) => s.brushMode);
  const setBrushSize = useOverlayStore((s) => s.setBrushSize);
  const setBrushMode = useOverlayStore((s) => s.setBrushMode);
  const brushHasInk = useOverlayStore((s) => s.brushHasInk);
  const clearBrush = useOverlayStore((s) => s.clearBrush);
  const { ready, finalize } = useOverlayFinalize();
  const { available: lastAvailable, restore: restoreLast } = useLastRegion();

  // Scrolling + Panoramic expose the scroll-direction picker inline so it
  // can be changed without leaving the overlay.
  const isScrollMode = mode === "scrolling" || mode === "panoramic";

  // The last-region restore only makes sense where the selection is a
  // single rect — the same set the `L` keybind accepts.
  const canRestoreLast =
    mode === "region" ||
    mode === "palette" ||
    mode === "grab-text" ||
    mode === "scrolling" ||
    mode === "panoramic";

  // The Region-family selection methods (Rectangle / Freehand / Pen /
  // Magnetic Lasso / Brush) share one dropdown control; Window swaps via
  // a tab. The remaining drag/draw modes (Multi-Area / Palette /
  // Grab-Text / Scrolling) show a static label.
  const inRegionMethod = isRegionMethod(mode);
  const showModeTabs = inRegionMethod || mode === "window";
  const modeLabel =
    mode === "palette"
      ? "Palette"
      : mode === "grab-text"
        ? "Grab Text"
        : mode === "scrolling"
          ? "Scrolling"
          : mode === "panoramic"
            ? "Panoramic"
            : "Multi-Area";
  // Scrolling records as the user scrolls; Panoramic auto-scrolls. Both
  // start a recording session rather than taking a one-shot capture.
  const ctaLabel =
    mode === "scrolling"
      ? "Record"
      : mode === "panoramic"
        ? "Start"
        : "Capture";

  const onCancel = () => {
    reset();
    void cancelRegionCapture();
  };

  return (
    <div
      {...CHROME_STOP_PROPS}
      className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20"
    >
      <div
        className={cn(
          // Toolbar shell — smaller padding, gentler border, lighter blur.
          "flex items-center gap-1 rounded-[14px] border bg-[var(--color-surface)]/85 px-1.5 py-1 backdrop-blur-[10px]",
          "border-[color:var(--hairline)] shadow-[var(--shadow-medium)]"
        )}
      >
        {/* ── Mode label / tabs ─────────────────────────────────────── */}
        {showModeTabs ? (
          <div className="flex items-center gap-0.5">
            {/* Region collapses into the selection-method dropdown; the
                remaining capture-type tabs sit beside it. */}
            {inRegionMethod && <RegionMethodMenu />}
            {SIDEBAR_ITEMS.map((item) => {
              // The Region tab is replaced by the method dropdown while a
              // Region method is active.
              if (item.id === "region" && inRegionMethod) return null;
              const Icon = item.icon;
              const active = item.id === mode;
              return (
                <button
                  key={item.id}
                  type="button"
                  title={
                    item.enabled ? item.label : `${item.label} (coming soon)`
                  }
                  disabled={!item.enabled}
                  aria-pressed={active}
                  onClick={() => {
                    if (!item.enabled || active) return;
                    if (item.id === "fullscreen") {
                      captureFullscreenFromOverlay();
                      return;
                    }
                    if (item.id === "region" || item.id === "window") {
                      // Re-open in that capture type — Window needs a fresh
                      // window enumeration, and Region resets to Rectangle.
                      reset();
                      void beginRegionCapture(item.id);
                    }
                  }}
                  className={cn(
                    "relative inline-flex items-center gap-1.5 rounded-[9px] px-2 py-1 text-[11.5px] font-medium",
                    "transition-colors duration-150",
                    active
                      ? "text-[var(--color-ink)]"
                      : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]",
                    !item.enabled && "cursor-not-allowed opacity-40"
                  )}
                >
                  <Icon size={12} strokeWidth={1.85} />
                  <span>{item.label}</span>
                  {active && <span className="ovl-tab-indicator" />}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="inline-flex items-center gap-2 px-2 py-1 text-[11.5px] font-semibold text-[var(--color-ink)]">
            {modeLabel}
            {mode === "multi-area" && areaCount > 0 && (
              <span className="rounded-md bg-[color:var(--color-accent)]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-accent)]">
                {areaCount}
              </span>
            )}
          </span>
        )}

        <span className="mx-1 h-5 w-px bg-[color:var(--color-overlay-2)]" />

        {/* ── Pen action cluster — anchor editing before the path closes ─ */}
        {mode === "pen" && phase !== "selected" && (
          <>
            <div className="flex items-center gap-0.5">
              <PenAction
                icon={Undo2}
                label="Remove last anchor"
                disabled={penCount === 0}
                onClick={popPenAnchor}
              />
              <PenAction
                icon={CornerDownLeft}
                label="Close path (Enter)"
                disabled={penCount < 3}
                onClick={closePen}
              />
            </div>
            <span className="mx-1 h-5 w-px bg-[color:var(--color-overlay-2)]" />
          </>
        )}

        {/* ── Brush controls — size / add-subtract / clear ──────────── */}
        {mode === "brush" && (
          <>
            <div className="flex items-center gap-2 pl-1 pr-0.5">
              <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-slate)]">
                <span>Size</span>
                <input
                  type="range"
                  min={2}
                  max={200}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  aria-label="Brush size"
                  className="h-1 w-20 cursor-pointer"
                  style={{ accentColor: "var(--color-accent)" }}
                />
                <span className="w-9 text-right tabular-nums text-[var(--color-ink)]">
                  {brushSize}px
                </span>
              </label>
              <div className="flex items-center rounded-[8px] bg-[color:var(--color-overlay-1)] p-0.5">
                <BrushSeg
                  active={brushModeVal === "add"}
                  onClick={() => setBrushMode("add")}
                  label="Add"
                />
                <BrushSeg
                  active={brushModeVal === "subtract"}
                  onClick={() => setBrushMode("subtract")}
                  label="Subtract"
                />
              </div>
              <button
                type="button"
                onClick={clearBrush}
                disabled={!brushHasInk}
                title="Clear the painted mask"
                className={cn(
                  "grid h-8 w-8 place-items-center rounded-[9px] transition-colors duration-150",
                  brushHasInk
                    ? "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
                    : "cursor-not-allowed text-[var(--color-hint)]/50"
                )}
                aria-label="Clear the painted mask"
              >
                <Trash2 size={14} strokeWidth={1.85} />
              </button>
            </div>
            <span className="mx-1 h-5 w-px bg-[color:var(--color-overlay-2)]" />
          </>
        )}

        {/* ── Scroll-direction picker (Scrolling / Panoramic) ───────── */}
        {isScrollMode && (
          <>
            <ScrollDirectionPicker
              value={scrollDirection}
              onChange={setScrollDirection}
              compact
            />
            <span className="mx-1 h-5 w-px bg-[color:var(--color-overlay-2)]" />
          </>
        )}

        {/* ── Restore the last region ───────────────────────────────── */}
        {canRestoreLast && (
          <>
            <button
              type="button"
              onClick={restoreLast}
              disabled={!lastAvailable}
              title={
                lastAvailable
                  ? "Select the same area as last time (L)"
                  : "No previous region yet"
              }
              aria-label="Restore the last region"
              className={cn(
                "grid h-8 w-8 place-items-center rounded-[9px] transition-colors duration-150",
                lastAvailable
                  ? "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
                  : "cursor-not-allowed text-[var(--color-hint)]/50"
              )}
            >
              <History size={14} strokeWidth={1.85} />
            </button>
            <span className="mx-1 h-5 w-px bg-[color:var(--color-overlay-2)]" />
          </>
        )}

        {/* ── Capture CTA — the focal action ────────────────────────── */}
        <button
          type="button"
          onClick={finalize}
          disabled={!ready}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-[10px] px-3 text-[12.5px] font-semibold",
            "transition-all duration-150",
            ready
              ? "capture-btn-ready bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:brightness-105 active:scale-[0.97]"
              : "border border-[color:var(--hairline)] text-[var(--color-hint)] cursor-not-allowed opacity-50"
          )}
        >
          <span
            className={cn(
              "grid h-[13px] w-[13px] place-items-center rounded-full border-[1.5px]",
              ready
                ? "border-[color:var(--color-accent-ink)]/85 capture-ring"
                : "border-[var(--color-accent)]"
            )}
            aria-hidden
          >
            <span
              className={cn(
                "h-[5px] w-[5px] rounded-full",
                ready
                  ? "bg-[var(--color-accent-ink)]"
                  : "bg-[var(--color-accent)]"
              )}
            />
          </span>
          {ctaLabel}
        </button>

        {/* ── Utility icons — collapse when no selection ────────────── */}
        <AnimatePresence initial={false}>
          {ready && (
            <motion.div
              key="utilities"
              initial={{ opacity: 0, width: 0, marginLeft: 0 }}
              animate={{ opacity: 1, width: "auto", marginLeft: 4 }}
              exit={{ opacity: 0, width: 0, marginLeft: 0 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-center overflow-hidden"
            >
              <span className="mr-1 h-5 w-px bg-[color:var(--color-overlay-2)]" />
              <div className="flex items-center gap-0.5">
                <IconToggle
                  icon={Eye}
                  label="Preview in editor"
                  checked={toggles.preview}
                  onChange={(v) => setToggles({ preview: v })}
                />
                <IconToggle
                  icon={Clipboard}
                  label="Copy to clipboard"
                  checked={toggles.clipboard}
                  onChange={(v) => setToggles({ clipboard: v })}
                />
                <IconToggle
                  icon={MousePointer2}
                  label="Capture cursor"
                  checked={toggles.cursor}
                  onChange={(v) => setToggles({ cursor: v })}
                />
                <IconToggle
                  icon={Sparkles}
                  label="Smart enhance — auto-level + sharpen"
                  checked={toggles.enhance}
                  onChange={(v) => setToggles({ enhance: v })}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <span className="mx-1 h-5 w-px bg-[color:var(--color-overlay-2)]" />

        {/* ── Cancel ───────────────────────────────────────────────── */}
        <button
          type="button"
          onClick={onCancel}
          className="grid h-8 w-8 place-items-center rounded-[10px] text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
          aria-label="Cancel"
          title="Cancel (Esc)"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

// ── Pen anchor-edit action ───────────────────────────────────────────

interface PenActionProps {
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  disabled: boolean;
  onClick: () => void;
}

function PenAction({ icon: Icon, label, disabled, onClick }: PenActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-[9px] transition-colors duration-150",
        disabled
          ? "cursor-not-allowed text-[var(--color-hint)]/50"
          : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
      )}
    >
      <Icon size={14} strokeWidth={1.85} />
    </button>
  );
}

// ── Brush add/subtract segmented button ──────────────────────────────

function BrushSeg({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-[6px] px-2 py-1 text-[11px] font-medium transition-colors",
        active
          ? "bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-subtle)]"
          : "text-[var(--color-slate)] hover:text-[var(--color-ink)]"
      )}
    >
      {label}
    </button>
  );
}

// ── Icon-only toggle ─────────────────────────────────────────────────

interface IconToggleProps {
  icon: ComponentType<{
    size?: number;
    strokeWidth?: number;
    className?: string;
  }>;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}

function IconToggle({
  icon: Icon,
  label,
  checked,
  onChange,
  disabled = false,
}: IconToggleProps) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      title={label}
      aria-label={label}
      aria-pressed={checked}
      disabled={disabled}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-[9px] transition-colors duration-150",
        disabled
          ? "cursor-not-allowed text-[var(--color-hint)]/60"
          : checked
            ? "bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]"
            : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
      )}
    >
      <Icon size={13} strokeWidth={1.85} />
    </button>
  );
}
