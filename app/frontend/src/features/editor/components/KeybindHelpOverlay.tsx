import { Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useEditorStore } from "../state/editorStore";
import {
  formatCombo,
  keybindGroups,
  type EditorKeybind,
} from "../keybinds";

/** Pre-formatted chip labels for a binding (explicit `helpKeys`, else the first
 *  combo's platform-aware formatting). */
function chipsFor(kb: EditorKeybind): string[] {
  return kb.helpKeys ?? formatCombo(kb.keys[0] ?? "");
}

/** Lowercased haystack for the filter: label + note + every combo's chips. */
function haystack(kb: EditorKeybind): string {
  return [kb.label, kb.note ?? "", ...kb.keys.flatMap(formatCombo)]
    .join(" ")
    .toLowerCase();
}

function KeyChips({ kb }: { kb: EditorKeybind }) {
  return (
    <span className="flex shrink-0 flex-wrap justify-end gap-1">
      {chipsFor(kb).map((k, i) => (
        <kbd
          key={`${kb.id}-${i}`}
          className="rounded-[5px] border border-[color:var(--ed-hairline-strong)] bg-[var(--ed-input-bg)] px-1.5 py-0.5 font-mono text-[10.5px] font-semibold leading-none text-[var(--ed-text)]"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

/**
 * `?` keyboard-shortcuts cheat-sheet for the editor. Reads the live keybind
 * registry (so it never drifts from the actual bindings) and renders it grouped
 * by category with platform-aware labels. Closes on Esc (owned here in a
 * capture listener so it beats the global handler), a backdrop click, or the
 * close button; `?` again toggles it via the central keybind. Lightweight —
 * plain conditional render, no animation dependency.
 */
export function KeybindHelpOverlay() {
  const open = useEditorStore((s) => s.helpOpen);
  const setHelpOpen = useEditorStore((s) => s.setHelpOpen);
  const [query, setQuery] = useState("");

  // Reset the filter whenever the overlay is dismissed.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Own Esc while open (capture phase) so it closes regardless of focus —
  // including from inside the search box, where the global Esc is suppressed.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setHelpOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setHelpOpen]);

  const groups = useMemo(() => {
    const all = keybindGroups();
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all
      .map((g) => ({
        ...g,
        items: g.items.filter((kb) => haystack(kb).includes(q)),
      }))
      .filter((g) => g.items.length > 0);
  }, [query]);

  if (!open) return null;

  return (
    <div
      className="clippity-editor absolute inset-0 z-50 grid place-items-center bg-black/50 p-6"
      onPointerDown={() => setHelpOpen(false)}
      role="presentation"
    >
      <div
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="flex max-h-full w-[680px] max-w-full flex-col overflow-hidden rounded-[14px] border border-[color:var(--ed-hairline-strong)] bg-[var(--ed-panel)] shadow-[var(--shadow-elevated)]"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-[color:var(--ed-hairline)] px-4 py-3">
          <h2 className="text-[14px] font-semibold text-[var(--ed-text)]">
            Keyboard shortcuts
          </h2>
          <div className="relative ml-auto w-48">
            <Search
              size={13}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ed-text-faint)]"
            />
            <input
              type="text"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter shortcuts"
              className="h-7 w-full rounded-[7px] border border-[color:var(--ed-hairline)] bg-[var(--ed-input-bg)] pl-7 pr-2 text-[12px] text-[var(--ed-text)] outline-none placeholder:text-[var(--ed-text-faint)] focus:border-[color:var(--ed-accent)]"
            />
          </div>
          <button
            type="button"
            onClick={() => setHelpOpen(false)}
            aria-label="Close shortcuts"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
          >
            <X size={15} strokeWidth={1.85} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
          {groups.length === 0 ? (
            <p className="py-8 text-center text-[12.5px] text-[var(--ed-text-dim)]">
              No shortcuts match “{query}”.
            </p>
          ) : (
            <div className="columns-2 gap-6 [column-fill:balance]">
              {groups.map((g) => (
                <section key={g.category} className="mb-4 break-inside-avoid">
                  <h3 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--ed-text-faint)]">
                    {g.label}
                  </h3>
                  <ul className="flex flex-col gap-1">
                    {g.items.map((kb) => (
                      <li
                        key={kb.id}
                        className="flex items-center gap-3 text-[12.5px]"
                      >
                        <span className="min-w-0 flex-1 truncate text-[var(--ed-text)]">
                          {kb.label}
                          {kb.note && (
                            <span className="ml-1.5 text-[10.5px] text-[var(--ed-text-faint)]">
                              {kb.note}
                            </span>
                          )}
                        </span>
                        <KeyChips kb={kb} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-[color:var(--ed-hairline)] px-4 py-2 text-[11px] text-[var(--ed-text-faint)]">
          Press <kbd className="font-mono font-semibold">?</kbd> any time ·{" "}
          <kbd className="font-mono font-semibold">Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
