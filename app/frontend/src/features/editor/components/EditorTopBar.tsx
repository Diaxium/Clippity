import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  Check,
  ChevronDown,
  CloudUpload,
  Redo2,
  Share,
  Undo2,
} from "lucide-react";

import { cn } from "@shared/lib/cn";

import { useEditorExport } from "../hooks/useEditorExport";
import { useEditorSave } from "../hooks/useEditorSave";
import { useEditorStore } from "../state/editorStore";
import { GROUP_OF, TOOL_BY_ID, TOOL_MENU } from "../tools";
import { toolInMode, type ToolId } from "../types";
import { ExportSection } from "./panels/ExportSection";

/** Square icon button in the bar's neutral chrome. Active state is a raised
 *  slab, never the accent — see the accent budget note on {@link EditorTopBar}. */
const ICON_BTN =
  "flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--ed-text-dim)] transition-colors hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]";

function IconButton({
  label,
  onClick,
  disabled,
  active,
  expanded,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-haspopup={expanded !== undefined ? "menu" : undefined}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        ICON_BTN,
        active && "bg-[var(--ed-active-bg)] text-[var(--ed-active-text)]",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent"
      )}
    >
      {children}
    </button>
  );
}

/**
 * Export cluster — a split button. The face exports with the current settings
 * (the common case, and the same thing Mod+E does); the caret opens the format
 * and scale options.
 *
 * This is the bar's only accent-filled control, which is deliberate: export is
 * the one action that ends the editing session, so it gets the single strongest
 * affordance on screen. Mod+Shift+E bumps `exportRequest`, which opens the
 * options popover directly.
 */
function ExportControl() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const exportRequest = useEditorStore((s) => s.exportRequest);
  const { exportImage, busy } = useEditorExport();

  useEffect(() => {
    if (exportRequest > 0) setOpen(true);
  }, [exportRequest]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-center">
      <div className="flex items-center overflow-hidden rounded-[8px]">
        <button
          type="button"
          disabled={busy}
          onClick={() => void exportImage()}
          className="h-8 bg-[var(--ed-accent)] px-3.5 text-[12px] font-semibold text-[var(--ed-on-accent)] transition-colors hover:bg-[var(--ed-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Export
        </button>
        <span
          aria-hidden
          className="h-8 w-px bg-[color:var(--ed-on-accent)] opacity-25"
        />
        <button
          type="button"
          title="Export options"
          aria-label="Export options"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex h-8 w-7 items-center justify-center bg-[var(--ed-accent)] text-[var(--ed-on-accent)] transition-colors hover:bg-[var(--ed-accent-hover)]"
        >
          <ChevronDown size={14} strokeWidth={2.5} />
        </button>
      </div>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-[10px] border border-[color:var(--ed-hairline-strong)] bg-[var(--ed-panel)] p-2 shadow-lg">
          <ExportSection />
        </div>
      )}
    </div>
  );
}

/**
 * The full tool list behind the toolbar's trailing caret.
 *
 * The toolbar used to hang a caret off every multi-tool group, which put four
 * carets in a row of eight buttons and made the cluster read as a stack of
 * dropdowns rather than a set of tools. One caret at the end holds every tool,
 * grouped, so the row itself can stay one-button-per-group.
 */
function ToolOverflow({
  availableByGroup,
  onPick,
}: {
  availableByGroup: readonly { id: string; toolIds: readonly ToolId[] }[];
  onPick: (id: ToolId, groupId: string) => void;
}) {
  const tool = useEditorStore((s) => s.tool);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-center">
      <IconButton
        label="All tools"
        expanded={open}
        active={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={15} strokeWidth={2} />
      </IconButton>
      {open && (
        <div
          role="menu"
          className="absolute left-1/2 top-full z-50 mt-1.5 min-w-[216px] -translate-x-1/2 rounded-[10px] border border-[color:var(--ed-hairline-strong)] p-1"
          style={{
            background: "var(--float-bg)",
            boxShadow: "var(--shadow-elevated)",
          }}
        >
          {availableByGroup.map((g, gi) => (
            <div key={g.id}>
              {gi > 0 && <div className="my-1 h-px bg-[var(--ed-hairline)]" />}
              {g.toolIds.map((id) => {
                const def = TOOL_BY_ID[id];
                if (!def) return null;
                const checked = tool === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    onClick={() => {
                      onPick(id, g.id);
                      setOpen(false);
                    }}
                    className="flex h-8 w-full items-center gap-2.5 rounded-[6px] px-2 text-[12px] text-[var(--ed-text)] hover:bg-[var(--ed-elev-hover)]"
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--ed-accent)]">
                      {checked && <Check size={13} strokeWidth={2.5} />}
                    </span>
                    <def.Icon
                      size={15}
                      className="shrink-0 text-[var(--ed-text-dim)]"
                    />
                    <span className="flex-1 text-left">{def.label}</span>
                    {def.shortcut && (
                      <span className="text-[11px] text-[var(--ed-text-faint)]">
                        {def.shortcut}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Editor top bar: an absolutely-centered tool cluster flanked by the mode
 * toggle on the left and the document actions on the right.
 *
 * **Accent budget.** Selection chrome here is neutral (`--ed-active-bg`) even
 * though it used to be accent-filled. The canvas below already spends the
 * accent on the selection outline and its handles, and a matching accent block
 * in the bar competed with it — at a glance you couldn't tell which highlight
 * meant "this is selected". The accent is now spent in three places only: the
 * Export button, the inspector's active tab, and the on-canvas selection.
 *
 * Self-contained — reads the scene store directly.
 */
export function EditorTopBar() {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);

  const { copyPng, busy } = useEditorExport();
  const { save } = useEditorSave();

  // Each group's last-used sub-tool — the icon its button shows, Figma-style.
  const [lastByGroup, setLastByGroup] = useState<Record<string, ToolId>>(() =>
    Object.fromEntries(TOOL_MENU.map((g) => [g.id, g.toolIds[0]!]))
  );

  // Keep a group's primary in sync when the tool changes outside the bar
  // (keyboard shortcut, floating toolbar, etc.).
  useEffect(() => {
    const gid = GROUP_OF[tool];
    if (gid)
      setLastByGroup((prev) =>
        prev[gid] === tool ? prev : { ...prev, [gid]: tool }
      );
  }, [tool]);

  const pickTool = (id: ToolId, gid: string) => {
    setTool(id);
    setLastByGroup((prev) => ({ ...prev, [gid]: id }));
  };

  // Only the tools available in the current mode (Workstream M), and only the
  // groups that have any left.
  const groups = TOOL_MENU.map((g) => ({
    id: g.id,
    toolIds: g.toolIds.filter((id) => toolInMode(id, mode)),
  })).filter((g) => g.toolIds.length > 0);

  return (
    <div className="relative z-40 flex h-12 items-center border-b border-[color:var(--ed-hairline)] bg-[var(--ed-panel)] px-3">
      <div role="radiogroup" aria-label="Editor mode" className="flex items-center gap-1">
        {(["annotate", "design"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-label={m === "annotate" ? "Annotation mode" : "Design mode"}
            aria-checked={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              "h-8 rounded-[8px] px-3 text-[12px] font-semibold transition-colors",
              mode === m
                ? "bg-[var(--ed-active-bg)] text-[var(--ed-active-text)]"
                : "text-[var(--ed-text-dim)] hover:text-[var(--ed-text)]"
            )}
          >
            {m === "annotate" ? "Annotate" : "Design"}
          </button>
        ))}
      </div>

      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1">
        {groups.map((g) => {
          const groupActive = GROUP_OF[tool] === g.id;
          const lastId = lastByGroup[g.id];
          const primaryId =
            lastId && g.toolIds.includes(lastId) ? lastId : g.toolIds[0]!;
          const primary = TOOL_BY_ID[primaryId];
          if (!primary) return null;
          return (
            <IconButton
              key={g.id}
              label={`${primary.label}${primary.shortcut ? `  ${primary.shortcut}` : ""}`}
              active={groupActive}
              onClick={() => pickTool(primaryId, g.id)}
            >
              <primary.Icon size={16} />
            </IconButton>
          );
        })}
        <ToolOverflow availableByGroup={groups} onPick={pickTool} />
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* Undo and redo read as one control because they are one control used
            in two directions — grouping them also keeps the disabled halves
            from looking like dead buttons scattered along the bar. */}
        <div className="flex items-center overflow-hidden rounded-[8px] border border-[color:var(--ed-hairline-strong)]">
          <IconButton label="Undo" disabled={!canUndo} onClick={() => undo()}>
            <Undo2 size={16} />
          </IconButton>
          <span aria-hidden className="h-5 w-px bg-[color:var(--ed-hairline-strong)]" />
          <IconButton label="Redo" disabled={!canRedo} onClick={() => redo()}>
            <Redo2 size={16} />
          </IconButton>
        </div>

        <div className="flex items-center rounded-[8px] border border-[color:var(--ed-hairline-strong)]">
          <IconButton label="Save  Ctrl S" onClick={() => void save()}>
            <CloudUpload size={16} />
          </IconButton>
        </div>

        <div className="flex items-center rounded-[8px] border border-[color:var(--ed-hairline-strong)]">
          <IconButton
            label="Copy to clipboard  Ctrl ⇧ C"
            disabled={busy}
            onClick={() => void copyPng()}
          >
            <Share size={16} />
          </IconButton>
        </div>

        <ExportControl />
      </div>
    </div>
  );
}
