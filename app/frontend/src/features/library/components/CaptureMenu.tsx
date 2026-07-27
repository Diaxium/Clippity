import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComponentType, MouseEvent } from "react";
import { createPortal } from "react-dom";

import { MoreHorizontal } from "lucide-react";

import { cn } from "@shared/lib/cn";

import { placePanel } from "../lib/anchorPanel";
import { captureActionEntries } from "../lib/captureActions";
import type { CaptureMeta, LibraryMode } from "../types";

const PANEL_W = 196;

interface CaptureMenuProps {
  meta: CaptureMeta;
  mode: LibraryMode;
  onDelete: (m: CaptureMeta) => void;
  onRestore: (m: CaptureMeta) => void;
  onPurge: (m: CaptureMeta) => void;
  className?: string;
}

/**
 * The card / row overflow menu — one button instead of the four-icon
 * cluster the cards used to carry.
 *
 * The inspector is where a capture's actions properly live now, and it
 * has room to spell them out. This is the shortcut for when it isn't
 * open (the pane is toggleable, and a narrow window hides it outright):
 * the same commands, one click deeper, without giving every card in the
 * grid a permanent toolbar.
 *
 * Rendered in a portal for the same reason `TagEditor` is — the grid
 * scrolls and a card near the bottom edge would have its menu clipped to
 * its first item. `placePanel` does the flip-and-clamp arithmetic.
 */
export function CaptureMenu({
  meta,
  mode,
  onDelete,
  onRestore,
  onPurge,
  className,
}: CaptureMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const panel = panelRef.current?.getBoundingClientRect();
      setPos(
        placePanel(
          trigger,
          { width: panel?.width || PANEL_W, height: panel?.height ?? 0 },
          { width: window.innerWidth, height: window.innerHeight }
        )
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

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

  // Same list the right-click menu builds — see `captureActions`. The
  // star is left out here because the card already shows a
  // `FavoriteButton` an inch away.
  const entries = captureActionEntries(meta, mode, {
    onDelete,
    onRestore,
    onPurge,
  });

  const panel = (
    <div
      ref={panelRef}
      role="menu"
      aria-label={`Actions for ${meta.title}`}
      style={{
        position: "fixed",
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: PANEL_W,
        // Hidden for the one frame between mounting and being measured,
        // so the menu is never seen in the wrong place.
        visibility: pos ? "visible" : "hidden",
      }}
      className="z-50 rounded-[11px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-medium)]"
    >
      {entries.map((entry, i) =>
        entry === "divider" ? (
          <div
            key={`divider-${i}`}
            role="separator"
            className="my-1 h-px bg-[color:var(--hairline)]"
          />
        ) : (
          <Item
            key={entry.id}
            icon={entry.icon}
            label={entry.label}
            danger={entry.danger}
            onClick={() => {
              setOpen(false);
              entry.onSelect();
            }}
          />
        )
      )}
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Actions for ${meta.title}`}
        aria-expanded={open}
        title="More actions"
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onDoubleClick={(e: MouseEvent) => e.stopPropagation()}
        className={cn(
          "focus-ring grid h-7 w-7 place-items-center rounded-md text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]",
          !open && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
          className
        )}
      >
        <MoreHorizontal size={15} strokeWidth={1.9} />
      </button>
      {open && createPortal(panel, document.body)}
    </>
  );
}

function Item({
  icon: Icon,
  label,
  onClick,
  danger = false,
}: {
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "focus-ring flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-left text-[12.5px] transition-colors",
        danger
          ? "text-[var(--ed-danger,#f24822)] hover:bg-[color:var(--color-overlay-1)]"
          : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
      )}
    >
      {Icon && <Icon size={14} strokeWidth={1.85} />}
      {label}
    </button>
  );
}
