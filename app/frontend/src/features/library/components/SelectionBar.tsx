import { useEffect, useRef, useState } from "react";

import { FolderInput, RotateCcw, Star, StarOff, Trash2, X } from "lucide-react";
import { motion } from "motion/react";

import {
  collectionsAddMembers,
  collectionsRemoveMembers,
} from "@services/tauri/clients/collections";
import { emitErrorToast } from "@services/tauri/clients/toast";
import { cn } from "@shared/lib/cn";

import { setFavorite } from "../lib/labelActions";
import { useLibraryStore } from "../state/libraryStore";
import type { CaptureMeta, Collection, LibraryMode } from "../types";
import { TagEditor } from "./TagEditor";

interface SelectionBarProps {
  /** The selected ids, in click order. */
  selected: string[];
  /** The currently visible captures, for resolving what is selected. */
  items: CaptureMeta[];
  mode: LibraryMode;
  collections: Collection[];
  /** The collection being viewed, if any — the only context in which
   *  "remove from collection" means something specific. */
  activeCollectionId: string | null;
  /** Every tag in use, for the tag editor's suggestions. */
  suggestions: string[];
  onTrash: (ids: string[]) => void;
  onRestore: (ids: string[]) => void;
  onPurge: (ids: string[]) => void;
}

/**
 * The bulk action bar — appears the moment anything is selected and
 * leaves when the selection is cleared.
 *
 * Every action it offers is a single IPC call over the whole selection
 * rather than a loop, because the label and collection commands take an
 * id list ([ADR 0029](../../../../../docs/decisions/0029-labels-are-a-sidecar-collections-are-a-document.md)).
 * Trash / restore / purge are the exception: those are per-file moves
 * with per-file failure modes, so they fan out — and one failing must
 * not stop the rest, which is why the caller runs them independently.
 *
 * It floats over the grid rather than pushing it down: a bar that
 * reflowed the list every time a checkbox was ticked would move the very
 * card the user was reaching for.
 */
export function SelectionBar({
  selected,
  items,
  mode,
  collections,
  activeCollectionId,
  suggestions,
  onTrash,
  onRestore,
  onPurge,
}: SelectionBarProps) {
  const clearSelection = useLibraryStore((s) => s.clearSelection);
  const [pickingCollection, setPickingCollection] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickingCollection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickingCollection(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!pickerRef.current?.contains(e.target as Node))
        setPickingCollection(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [pickingCollection]);

  if (selected.length === 0) return null;

  const chosen = items.filter((m) => selected.includes(m.id));
  // "Star" when any of them isn't starred yet; once they all are, the
  // same button unstars — one control, and its label always says which.
  const willStar = chosen.some((m) => m.favorite !== true);

  const addToCollection = async (collection: Collection) => {
    setPickingCollection(false);
    try {
      await collectionsAddMembers(collection.id, selected);
      clearSelection();
    } catch (err) {
      void emitErrorToast(
        err instanceof Error ? err.message : "Failed to add to the collection."
      );
    }
  };

  const removeFromCollection = async () => {
    if (!activeCollectionId) return;
    try {
      await collectionsRemoveMembers(activeCollectionId, selected);
      clearSelection();
    } catch (err) {
      void emitErrorToast(
        err instanceof Error
          ? err.message
          : "Failed to remove from the collection."
      );
    }
  };

  return (
    <motion.div
      initial={{ y: 12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.16, ease: [0.4, 0, 0.2, 1] }}
      className="pointer-events-none sticky bottom-0 z-10 flex justify-center pb-1 pt-3"
    >
      <div className="pointer-events-auto flex items-center gap-1 rounded-[14px] border border-[color:var(--hairline)] bg-[var(--color-surface)] px-2 py-1.5 shadow-[var(--shadow-medium)]">
        <span className="px-2 text-[12.5px] font-semibold text-[var(--color-ink)]">
          {selected.length} selected
        </span>
        <Divider />

        {mode === "trash" ? (
          <>
            <BarBtn
              icon={RotateCcw}
              label="Restore"
              onClick={() => onRestore(selected)}
            />
            <BarBtn
              icon={Trash2}
              label="Delete permanently"
              onClick={() => onPurge(selected)}
            />
          </>
        ) : (
          <>
            <BarBtn
              icon={willStar ? Star : StarOff}
              label={willStar ? "Favorite" : "Unfavorite"}
              onClick={() => void setFavorite(selected, willStar)}
            />
            <TagEditor ids={selected} current={[]} suggestions={suggestions} />

            <div ref={pickerRef} className="relative">
              <BarBtn
                icon={FolderInput}
                label="Add to collection"
                onClick={() => setPickingCollection((v) => !v)}
              />
              {pickingCollection && (
                <div
                  role="menu"
                  aria-label="Add to collection"
                  className="absolute bottom-full right-0 z-20 mb-1.5 w-52 rounded-[12px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-medium)]"
                >
                  {collections.length === 0 ? (
                    <p className="px-2 py-1.5 text-[12px] text-[var(--color-hint)]">
                      No collections yet — make one in the rail above.
                    </p>
                  ) : (
                    collections.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        role="menuitem"
                        onClick={() => void addToCollection(c)}
                        className="focus-ring w-full truncate rounded-[8px] px-2 py-1.5 text-left text-[12.5px] text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
                      >
                        {c.name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {activeCollectionId && (
              <BarBtn
                icon={X}
                label="Remove from this collection"
                onClick={() => void removeFromCollection()}
              />
            )}
            <BarBtn
              icon={Trash2}
              label="Move to trash"
              onClick={() => onTrash(selected)}
            />
          </>
        )}

        <Divider />
        <button
          type="button"
          onClick={clearSelection}
          className="focus-ring rounded-[9px] px-2.5 py-1 text-[12.5px] font-medium text-[var(--color-slate)] transition-colors hover:text-[var(--color-ink)]"
        >
          Cancel
        </button>
      </div>
    </motion.div>
  );
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-[color:var(--hairline)]" />;
}

function BarBtn({
  icon: Icon,
  label,
  onClick,
  className,
}: {
  icon: typeof Star;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "focus-ring grid h-8 w-8 place-items-center rounded-[9px] text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]",
        className
      )}
    >
      <Icon size={15} strokeWidth={1.85} />
    </button>
  );
}
