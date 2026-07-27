import { useEffect, useRef, useState } from "react";

import { ChevronDown, ClipboardPaste, Focus, Search, X } from "lucide-react";

import { ingestClipboard } from "@services/tauri/clients/capture";
import { emitErrorToast, showCaptureWindow } from "@services/tauri/clients/toast";
import { cn } from "@shared/lib/cn";

/**
 * The library's page header: what this is, a way to search it, and the
 * one action that puts something new in it.
 *
 * Search lives here rather than in the toolbar below because it cuts
 * across every destination in the rail — it narrows whichever one is
 * open instead of belonging to any of them — and because Ctrl/⌘-K
 * should always land somewhere visible.
 *
 * The capture button is a split control: the left half does the common
 * thing (open the capture window) and the chevron opens the one
 * alternative that doesn't need an overlay at all (ingest whatever is on
 * the clipboard). Both are real; nothing here is a placeholder.
 */
export function LibraryTopBar({
  heading,
  search,
  onSearch,
}: {
  heading: string;
  search: string;
  onSearch: (q: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Ctrl/⌘-K focuses the box, Escape leaves it — the two shortcuts every
  // search field is expected to answer. Scoped to this window, which is
  // enough: the library is one view of one window, and a global
  // accelerator would fight the capture hotkeys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const pasteFromClipboard = async () => {
    setMenuOpen(false);
    try {
      const result = await ingestClipboard(false);
      if (result.kind === "empty") {
        void emitErrorToast("Nothing on the clipboard to import.");
      }
    } catch (err) {
      void emitErrorToast(
        err instanceof Error ? err.message : "Failed to read the clipboard."
      );
    }
  };

  return (
    <header className="flex items-center gap-4 px-5 py-3.5">
      <h1 className="shrink-0 text-[19px] font-bold tracking-tight text-[var(--color-ink)]">
        {heading}
      </h1>

      <div className="relative mx-auto w-full max-w-[420px]">
        <Search
          size={15}
          strokeWidth={1.85}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-hint)]"
        />
        <input
          ref={inputRef}
          type="search"
          value={search}
          onChange={(e) => onSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onSearch("");
              e.currentTarget.blur();
            }
          }}
          placeholder="Search library…"
          aria-label="Search library"
          className="focus-ring h-9 w-full rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-surface)] pl-9 pr-16 text-[13px] text-[var(--color-ink)] outline-none transition-colors placeholder:text-[var(--color-hint)] focus-visible:border-[color:var(--color-accent)]/45"
        />
        {search ? (
          <button
            type="button"
            onClick={() => onSearch("")}
            aria-label="Clear search"
            title="Clear search"
            className="focus-ring absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-[7px] text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
          >
            <X size={13} strokeWidth={2.2} />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-[6px] border border-[color:var(--hairline)] bg-[color:var(--color-overlay-1)] px-1.5 py-0.5 font-sans text-[10px] font-medium text-[var(--color-hint)]">
            Ctrl K
          </kbd>
        )}
      </div>

      <div ref={menuRef} className="relative shrink-0">
        <div className="flex items-center overflow-hidden rounded-[10px] shadow-[var(--shadow-subtle)]">
          <button
            type="button"
            onClick={() => void showCaptureWindow()}
            className="focus-ring inline-flex h-9 items-center gap-2 bg-[var(--color-accent)] px-3.5 text-[13px] font-semibold text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]"
          >
            <Focus size={15} strokeWidth={2} />
            Capture
          </button>
          <span className="h-9 w-px bg-black/15" />
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="More capture options"
            aria-expanded={menuOpen}
            className="focus-ring grid h-9 w-7 place-items-center bg-[var(--color-accent)] text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]"
          >
            <ChevronDown size={14} strokeWidth={2.2} />
          </button>
        </div>

        {menuOpen && (
          <div
            role="menu"
            aria-label="Capture options"
            className="absolute right-0 top-full z-40 mt-1.5 w-56 rounded-[12px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-medium)]"
          >
            <MenuItem
              icon={Focus}
              label="New capture"
              onClick={() => {
                setMenuOpen(false);
                void showCaptureWindow();
              }}
            />
            <MenuItem
              icon={ClipboardPaste}
              label="Paste from clipboard"
              onClick={() => void pasteFromClipboard()}
            />
          </div>
        )}
      </div>
    </header>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  className,
}: {
  icon: typeof Focus;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "focus-ring flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px] text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]",
        className
      )}
    >
      <Icon size={14} strokeWidth={1.85} />
      {label}
    </button>
  );
}
