import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@shared/lib/cn";

import { useEditorExport } from "../hooks/useEditorExport";
import { useEditorStore } from "../state/editorStore";

type Entry =
  | "divider"
  | { label: string; shortcut?: string; disabled?: boolean; run: () => void };

const MARGIN = 8;

/**
 * Custom right-click menu for the editor, replacing the WebView2 default. Reads
 * the open descriptor from the store and builds node- or canvas-scoped actions;
 * the canvas/layers panel populate it via `openContextMenu`. Closes on action,
 * outside-press, Escape, scroll, or blur.
 */
export function EditorContextMenu() {
  const menu = useEditorStore((s) => s.contextMenu);
  const hasClipboard = useEditorStore((s) => s.clipboard !== null);
  const selectedCount = useEditorStore((s) => s.selectedIds.length);
  const close = useEditorStore((s) => s.closeContextMenu);
  const { busy, exportImage } = useEditorExport();

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!menu) return;
    const el = ref.current;
    const r = el?.getBoundingClientRect();
    const w = r?.width ?? 220;
    const h = r?.height ?? 0;
    setPos({
      left: Math.max(MARGIN, Math.min(menu.x, window.innerWidth - w - MARGIN)),
      top: Math.max(MARGIN, Math.min(menu.y, window.innerHeight - h - MARGIN)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu, close]);

  if (!menu) return null;

  const s = useEditorStore.getState;
  const ids = () => s().selectedIds;
  const entries: Entry[] =
    menu.kind === "node"
      ? [
          {
            label: "Copy",
            shortcut: "Ctrl C",
            run: () => s().copyNodes(ids()),
          },
          {
            label: "Duplicate",
            shortcut: "Ctrl D",
            run: () => s().duplicateNodes(ids()),
          },
          {
            label: "Rename",
            disabled: selectedCount !== 1,
            run: () => {
              const id = ids()[0];
              if (id) s().requestRename(id);
            },
          },
          {
            label: "Export",
            disabled: busy || selectedCount !== 1,
            run: () => {
              const id = ids()[0];
              if (id) void exportImage({ nodeId: id });
            },
          },
          {
            label: "Paste here",
            shortcut: "Ctrl V",
            disabled: !hasClipboard,
            run: () => s().pasteClipboard({ x: menu.sceneX, y: menu.sceneY }),
          },
          "divider",
          { label: "Delete", shortcut: "Del", run: () => s().removeSelected() },
          "divider",
          {
            label: "Bring to front",
            shortcut: "Ctrl ⇧ ]",
            run: () => s().bringToFront(ids()),
          },
          {
            label: "Bring forward",
            shortcut: "Ctrl ]",
            run: () => s().bringForward(ids()),
          },
          {
            label: "Send backward",
            shortcut: "Ctrl [",
            run: () => s().sendBackward(ids()),
          },
          {
            label: "Send to back",
            shortcut: "Ctrl ⇧ [",
            run: () => s().sendToBack(ids()),
          },
        ]
      : [
          {
            label: "Paste here",
            shortcut: "Ctrl V",
            disabled: !hasClipboard,
            run: () => s().pasteClipboard({ x: menu.sceneX, y: menu.sceneY }),
          },
          {
            label: "Select all",
            shortcut: "Ctrl A",
            run: () => s().selectAll(),
          },
          "divider",
          {
            label: "Zoom to fit",
            shortcut: "Shift 1",
            run: () => s().fitView(),
          },
          {
            label: "Zoom to 100%",
            shortcut: "Ctrl 0",
            run: () => s().resetZoom(),
          },
        ];

  return (
    <>
      {/* Full-screen catcher closes the menu on any outside press. */}
      <div
        className="no-drag fixed inset-0 z-[60]"
        onPointerDown={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div
        ref={ref}
        className="no-drag fixed z-[61] min-w-[200px] rounded-[8px] border border-[color:var(--ed-hairline-strong)] bg-[var(--ed-elev)] p-1 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
        style={{ left: pos.left, top: pos.top }}
      >
        {entries.map((entry, i) =>
          entry === "divider" ? (
            <div key={`d${i}`} className="my-1 h-px bg-[var(--ed-hairline)]" />
          ) : (
            <button
              key={entry.label}
              type="button"
              disabled={entry.disabled}
              onClick={() => {
                if (entry.disabled) return;
                entry.run();
                close();
              }}
              className={cn(
                "flex h-7 w-full items-center justify-between gap-6 rounded-[5px] px-2 text-[12px]",
                entry.disabled
                  ? "cursor-default text-[var(--ed-text-faint)]"
                  : "text-[var(--ed-text)] hover:bg-[var(--ed-accent)] hover:text-[var(--ed-on-accent)]"
              )}
            >
              <span>{entry.label}</span>
              {entry.shortcut && (
                <span className="text-[11px] text-[var(--ed-text-dim)]">
                  {entry.shortcut}
                </span>
              )}
            </button>
          )
        )}
      </div>
    </>
  );
}
