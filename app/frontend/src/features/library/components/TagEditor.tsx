import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Tag, X } from "lucide-react";

import { cn } from "@shared/lib/cn";

import { addTags, removeTags } from "../lib/labelActions";
import type { CaptureMeta } from "../types";

/** Panel width, and the gap it keeps from its trigger and the viewport. */
const PANEL_W = 240;
const GAP = 6;
const MARGIN = 8;

/**
 * Tag editor popover — the same control for one capture and for a
 * selection.
 *
 * With a single capture it shows that capture's tags, each removable,
 * and adds what you type. With a selection it only *adds*: removing a
 * tag across a mixed selection has no honest meaning ("remove `bug` from
 * forty captures, three of which have it" is a different action from
 * what the row of chips would be showing), so the panel doesn't offer
 * it. The chips on each card remain the way to take one off.
 *
 * Suggestions are the tags already in use elsewhere in the library,
 * filtered by what has been typed. They exist to stop the vocabulary
 * fragmenting — `bug`, `bugs`, `Bug-report` — which is the failure mode
 * of freeform tags and the reason the backend normalises case.
 *
 * **The panel renders in a portal, positioned against its trigger.**
 * Every place this control lives is inside something that clips: a
 * capture card is `overflow-hidden` (its rounded corners depend on it),
 * the grid scrolls, and the selection bar is pinned to the bottom of the
 * window with no room below it at all. An absolutely-positioned panel is
 * cut off in all three. Escaping to `document.body` and flipping above
 * the trigger when the space below won't hold it is the one fix that
 * covers every host, present and future.
 */
export function TagEditor({
  ids,
  current,
  suggestions,
  compact = false,
}: {
  ids: string[];
  /** The tags of the single capture being edited; empty for a
   *  selection, which has no one tag list. */
  current: string[];
  /** Every tag in use in the library — the vocabulary to reuse. */
  suggestions: string[];
  /** Icon-only trigger, for the card / row action cluster. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const single = ids.length === 1;

  const matches = useMemo(() => {
    const typed = draft.trim().toLowerCase();
    const already = new Set(current.map((t) => t.toLowerCase()));
    return suggestions
      .filter((t) => !already.has(t.toLowerCase()))
      .filter((t) => !typed || t.toLowerCase().includes(typed))
      .slice(0, 6);
  }, [draft, current, suggestions]);

  // Place the panel against the trigger, in viewport coordinates.
  //
  // Re-runs when the content resizes (a suggestion list that grew or
  // shrank changes whether the panel still fits below) and on scroll —
  // captured, so an ancestor scrolling the grid moves the panel with its
  // card rather than leaving it stranded mid-air.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const panel = panelRef.current?.getBoundingClientRect();
      const width = panel?.width || PANEL_W;
      const height = panel?.height ?? 0;

      // Right-aligned to the trigger, then clamped so a card at the
      // edge of the window doesn't push the panel out of it.
      const left = Math.max(
        MARGIN,
        Math.min(trigger.right - width, window.innerWidth - width - MARGIN)
      );
      const below = trigger.bottom + GAP;
      const flip = height > 0 && below + height > window.innerHeight - MARGIN;
      const top = flip
        ? Math.max(MARGIN, trigger.top - height - GAP)
        : below;
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, matches.length, current.length, single]);

  // Dismiss on Escape or a click elsewhere — a popover that survives
  // either one strands itself over the grid. The panel is outside the
  // trigger's subtree now, so both have to count as "inside".
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const commit = (tag: string) => {
    const value = tag.trim();
    if (!value) return;
    setDraft("");
    void addTags(ids, [value]);
  };

  const label = single ? "Edit tags" : `Tag ${ids.length} captures`;

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      style={{
        position: "fixed",
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: PANEL_W,
        // Hidden for the one frame between mounting and being measured,
        // so the panel is never seen in the wrong place.
        visibility: pos ? "visible" : "hidden",
      }}
      className="z-50 rounded-[12px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-2.5 shadow-[var(--shadow-medium)]"
    >
      {single && current.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {current.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-overlay-1)] py-0.5 pl-2 pr-1 text-[11px] font-medium text-[var(--color-slate)]"
            >
              {tag}
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                title={`Remove ${tag}`}
                onClick={() => void removeTags(ids, [tag])}
                className="focus-ring grid h-4 w-4 place-items-center rounded-full hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
              >
                <X size={10} strokeWidth={2.4} />
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          }
        }}
        placeholder={single ? "Add a tag…" : `Tag ${ids.length} captures…`}
        aria-label="New tag"
        className="focus-ring w-full rounded-[8px] border border-[color:var(--hairline)] bg-[var(--color-surface-2)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-hint)]"
      />

      {matches.length > 0 && (
        <ul className="mt-1.5 flex flex-col">
          {matches.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                onClick={() => commit(tag)}
                className="focus-ring w-full truncate rounded-[7px] px-2 py-1 text-left text-[12px] text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
              >
                {tag}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn(
          "focus-ring inline-flex items-center gap-1.5 rounded-md transition-colors",
          compact
            ? "h-7 w-7 justify-center text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
            : "h-8 px-2.5 text-[12.5px] font-medium text-[var(--color-ink)] hover:bg-[color:var(--color-overlay-2)]"
        )}
      >
        <Tag size={14} strokeWidth={1.85} />
        {!compact && "Tag"}
      </button>
      {open && createPortal(panel, document.body)}
    </>
  );
}

/** The tags of `meta`, or an empty list — the shape `TagEditor.current`
 *  wants, without every call site repeating the `?? []`. */
export function tagsOf(meta: CaptureMeta): string[] {
  return meta.tags ?? [];
}
