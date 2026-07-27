import { useRef } from "react";

import { cn } from "@shared/lib/cn";

import { THUMBNAIL_LIST_W, THUMBNAIL_LIST_W_TRASH } from "../constants";
import { useCaptureClick } from "../hooks/useCaptureClick";
import { useCaptureContextMenu } from "../hooks/useCaptureContextMenu";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { useThumbnail } from "../hooks/useThumbnail";
import { auxClipboardText } from "../lib/auxClipboard";
import {
  captureDetail,
  formatBytes,
  formatProvenance,
  formatTime,
} from "../lib/format";
import { KIND_BADGE } from "../modes";
import { useLibraryStore } from "../state/libraryStore";
import type { CaptureMeta, LibraryMode } from "../types";
import { AuxPreview } from "./AuxPreview";
import { CaptureMenu } from "./CaptureMenu";
import { FavoriteButton } from "./FavoriteButton";
import { PalettePreview } from "./PalettePreview";
import { SelectCheckbox } from "./SelectCheckbox";
import { TagChips } from "./TagChips";

interface CaptureRowProps {
  meta: CaptureMeta;
  mode: LibraryMode;
  onFocus: (m: CaptureMeta) => void;
  onOpen: (m: CaptureMeta) => void;
  onDelete: (m: CaptureMeta) => void;
  onRestore: (m: CaptureMeta) => void;
  onPurge: (m: CaptureMeta) => void;
}

/**
 * List-variant capture row. Same interaction contract as the card —
 * click focuses, double-click opens, Ctrl/⌘-click and Shift-click
 * multi-select (see `useCaptureClick`) — with the room a row has for the
 * columns a card can't show: dimensions and size side by side, and the
 * tags inline rather than wrapped.
 */
export function CaptureRow({
  meta,
  mode,
  onFocus,
  onOpen,
  onDelete,
  onRestore,
  onPurge,
}: CaptureRowProps) {
  const rowRef = useRef<HTMLLIElement>(null);
  const selected = useLibraryStore((s) => s.selected.includes(meta.id));
  const focused = useLibraryStore((s) => s.focusedId === meta.id);

  const width = mode === "trash" ? THUMBNAIL_LIST_W_TRASH : THUMBNAIL_LIST_W;
  const isAux =
    meta.kind === "color" || meta.kind === "palette" || meta.kind === "text";
  const isPalette = meta.kind === "palette" && !!meta.palette?.length;
  const thumb = useThumbnail(rowRef, isAux ? null : meta.id, width);
  const { copied, copy } = useCopyFeedback();
  // Short, stable part inline; the full window title in the tooltip —
  // see `formatProvenance`.
  const provenance = formatProvenance(meta);
  // Dimensions for a file, hex / swatch count / word count for the aux
  // kinds. The bare detail, not `captureSubtitle` — the row shows the
  // kind badge as its own chip further along, so prefixing it here would
  // print "MP4" twice.
  const detail = captureDetail(meta);
  const opensByCopying = meta.kind === "color" || meta.kind === "text";

  const selectHandlers = useCaptureClick(meta, onFocus);

  // Same contract as the card: opening a color or a text run copies it.
  const open = () => {
    if (opensByCopying) void copy(auxClipboardText(meta));
    else onOpen(meta);
  };

  const onContextMenu = useCaptureContextMenu(meta, mode, {
    onFocus,
    onDelete,
    onRestore,
    onPurge,
  });

  return (
    <li
      ref={rowRef}
      role="button"
      tabIndex={0}
      aria-pressed={focused}
      {...selectHandlers}
      onDoubleClick={open}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter") open();
        if (e.key === " ") {
          e.preventDefault();
          onFocus(meta);
        }
      }}
      className={cn(
        "group focus-ring flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors",
        focused
          ? "bg-[color:var(--color-accent-soft)]"
          : selected
            ? "bg-[color:var(--color-overlay-1)]"
            : "hover:bg-[color:var(--color-overlay-1)]"
      )}
    >
      <SelectCheckbox id={meta.id} />
      <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded-md border border-[color:var(--hairline)] bg-[var(--color-surface-2)]">
        {isPalette ? (
          <PalettePreview palette={meta.palette!} />
        ) : isAux ? (
          <AuxPreview meta={meta} />
        ) : thumb ? (
          <img
            src={thumb}
            alt={meta.title}
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-[var(--color-ink)]">
          {meta.title}
        </p>
        <p
          className="mt-0.5 flex items-center gap-2 text-[11.5px] text-[var(--color-hint)]"
          title={provenance || undefined}
        >
          <span>{copied ? "Copied" : formatTime(meta.createdAtMs)}</span>
          {detail && (
            <>
              <Dot />
              <span className="truncate">{detail}</span>
            </>
          )}
          {!isAux && (
            <>
              <Dot />
              <span>{formatBytes(meta.sizeBytes)}</span>
            </>
          )}
          {meta.sourceApp && (
            <>
              <Dot />
              <span className="truncate">{meta.sourceApp}</span>
            </>
          )}
        </p>
      </div>
      <TagChips meta={meta} max={2} />
      <span className="rounded-md bg-[color:var(--color-overlay-1)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-slate)]">
        {KIND_BADGE[meta.kind] ?? meta.kind}
      </span>
      {mode === "library" && <FavoriteButton meta={meta} />}
      <CaptureMenu
        meta={meta}
        mode={mode}
        onDelete={onDelete}
        onRestore={onRestore}
        onPurge={onPurge}
      />
    </li>
  );
}

function Dot() {
  return <span className="h-0.5 w-0.5 rounded-full bg-[var(--color-hint)]" />;
}
