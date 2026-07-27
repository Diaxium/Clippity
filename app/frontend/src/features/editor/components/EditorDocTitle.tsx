import { useEffect, useRef, useState } from "react";

import { ChevronDown } from "lucide-react";

import { useEditorSave } from "../hooks/useEditorSave";
import { useEditorStore } from "../state/editorStore";
import { IS_MAC } from "../keybinds";

const STATUS_LABEL: Record<"draft" | "edited" | "saved", string> = {
  draft: "Draft",
  edited: "Edited",
  saved: "Saved",
};

/**
 * Compact document title control for the window title bar: an inline-editable
 * name, a status pill, and a chevron menu whose only entry re-enters rename.
 * Self-contained — reads/writes `docName`/`docStatus` on the scene store.
 */
export function EditorDocTitle() {
  const docName = useEditorStore((s) => s.docName);
  const docStatus = useEditorStore((s) => s.docStatus);
  const setDocName = useEditorStore((s) => s.setDocName);
  const { save, saving } = useEditorSave();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const beginEdit = () => {
    setDraft(docName);
    setEditing(true);
    setMenuOpen(false);
  };

  const commit = () => {
    const next = draft.trim();
    if (next) setDocName(next);
    setEditing(false);
  };

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  return (
    <div className="no-drag flex items-center gap-2">
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") setEditing(false);
          }}
          className="h-6 rounded-[5px] bg-[var(--color-overlay-2)] px-1.5 text-[13px] font-medium text-[var(--color-ink)] outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={beginEdit}
          className="rounded-[5px] px-1 text-[13px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-overlay-1)]"
        >
          {docName}
        </button>
      )}

      <span className="rounded-[5px] bg-[var(--color-overlay-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-hint)]">
        {STATUS_LABEL[docStatus]}
      </span>

      <div ref={menuRef} className="relative">
        <button
          type="button"
          title="Document menu"
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center justify-center text-[var(--color-hint)] hover:text-[var(--color-ink)]"
        >
          <ChevronDown size={14} />
        </button>
        {menuOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 min-w-[150px] rounded-[8px] border border-[color:var(--hairline-strong)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-elevated)]">
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setMenuOpen(false);
                void save();
              }}
              className="flex h-7 w-full items-center justify-between gap-3 rounded-[6px] px-2 text-left text-[12px] text-[var(--color-ink)] hover:bg-[var(--color-overlay-2)] disabled:opacity-50"
            >
              <span>{saving ? "Saving…" : "Save"}</span>
              <span className="text-[10px] text-[var(--color-hint)]">
                {IS_MAC ? "⌘S" : "Ctrl+S"}
              </span>
            </button>
            <button
              type="button"
              onClick={beginEdit}
              className="h-7 w-full rounded-[6px] px-2 text-left text-[12px] text-[var(--color-ink)] hover:bg-[var(--color-overlay-2)]"
            >
              Rename
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
