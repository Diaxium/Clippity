import { useRef } from "react";
import type { ReactNode } from "react";

import { Baseline, Clapperboard, Images } from "lucide-react";
import { motion } from "motion/react";

import { cn } from "@shared/lib/cn";

import { THUMBNAIL_GRID_W, THUMBNAIL_GRID_W_TRASH } from "../constants";
import { useCaptureContextMenu } from "../hooks/useCaptureContextMenu";
import { useCaptureClick } from "../hooks/useCaptureClick";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { useThumbnail } from "../hooks/useThumbnail";
import { auxClipboardText } from "../lib/auxClipboard";
import { captureSubtitle, formatTime } from "../lib/format";
import { KIND_BADGE } from "../modes";
import { useLibraryStore } from "../state/libraryStore";
import type { CaptureMeta, LibraryMode } from "../types";
import { AuxPreview } from "./AuxPreview";
import { CaptureMenu } from "./CaptureMenu";
import { FavoriteButton } from "./FavoriteButton";
import { PalettePreview } from "./PalettePreview";
import { SelectCheckbox } from "./SelectCheckbox";

/** Kinds that get a chip over their preview, and the glyph it carries.
 *  Everything else is left bare — see the badge's comment below. */
const BADGED_KINDS: Partial<Record<CaptureMeta["kind"], ReactNode>> = {
  video: <Clapperboard size={10} strokeWidth={2} />,
  gif: <Images size={10} strokeWidth={2} />,
  text: <Baseline size={10} strokeWidth={2} />,
};

interface CaptureCardProps {
  meta: CaptureMeta;
  mode: LibraryMode;
  /** Show this capture in the inspector. */
  onFocus: (m: CaptureMeta) => void;
  /** Open it for real — the editor, or the large palette view. Not
   *  called for the kinds whose "open" is a clipboard write; the card
   *  handles those itself so it can acknowledge them. */
  onOpen: (m: CaptureMeta) => void;
  onDelete: (m: CaptureMeta) => void;
  onRestore: (m: CaptureMeta) => void;
  onPurge: (m: CaptureMeta) => void;
}

/**
 * Grid-variant capture card.
 *
 * **One click focuses, two clicks open.** The card is the handle for a
 * capture, not a link: the common gesture is "show me this one" — which
 * fills the inspector and costs nothing to undo — and opening the editor
 * is the deliberate second click. Ctrl/⌘-click adds one to the
 * multi-select and Shift-click takes the whole run since the last card
 * touched, so a selection can be built without ever hitting the
 * checkboxes (`useCaptureClick` owns the modifier ladder).
 *
 * Focus and selection are drawn differently on purpose. The focused card
 * is the one the inspector is describing (accent frame + tint); selected
 * cards are the ones a bulk action would hit (accent border, no tint). A
 * card is very often both, so conflating them would leave the user unable
 * to tell which captures "Move to trash" is about to take.
 *
 * **"Open" means the terminal act for the kind**, not one fixed
 * destination. A screenshot opens in the editor and a palette opens its
 * full-size view, but a color and a text run have no view worth showing
 * — their whole content already fits on the card — so opening one copies
 * it. That is what a person does with a sampled color next, and routing
 * it through a no-op "open" would leave two of the six kinds with a
 * double-click that does nothing.
 *
 * The chrome (checkbox, star) stays hidden until hover: a wall of
 * permanent controls turns a gallery into a form.
 */
export function CaptureCard({
  meta,
  mode,
  onFocus,
  onOpen,
  onDelete,
  onRestore,
  onPurge,
}: CaptureCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const selected = useLibraryStore((s) => s.selected.includes(meta.id));
  const focused = useLibraryStore((s) => s.focusedId === meta.id);

  const width = mode === "trash" ? THUMBNAIL_GRID_W_TRASH : THUMBNAIL_GRID_W;
  const isAux =
    meta.kind === "color" || meta.kind === "palette" || meta.kind === "text";
  const isPalette = meta.kind === "palette" && !!meta.palette?.length;
  const thumb = useThumbnail(cardRef, isAux ? null : meta.id, width);
  const { copied, copy } = useCopyFeedback();

  // A color or a text run has no larger view to open — its content is
  // already fully on the card — so opening it puts it on the clipboard.
  const opensByCopying = meta.kind === "color" || meta.kind === "text";
  const subtitle = captureSubtitle(meta);

  const selectHandlers = useCaptureClick(meta, onFocus);

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
    <motion.div
      ref={cardRef}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
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
        "group focus-ring cursor-pointer rounded-[14px] border p-1.5 transition-colors",
        focused
          ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]"
          : selected
            ? "border-[color:var(--color-accent)]/55"
            : "border-transparent hover:bg-[color:var(--color-overlay-1)]"
      )}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-surface-2)]">
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
        ) : (
          <span className="absolute inset-0 grid place-items-center text-[11px] text-[var(--color-hint)]">
            Loading…
          </span>
        )}

        {/* Only the kinds whose preview misrepresents them get a badge.
            A "PNG" chip on a screenshot repeats the line below, and a
            swatch is unmistakably a color — but a motionless video
            thumbnail and a paragraph of grabbed text both look exactly
            like a screenshot until something says otherwise. */}
        {BADGED_KINDS[meta.kind] && (
          <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-[6px] bg-black/55 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-white">
            {BADGED_KINDS[meta.kind]}
            {KIND_BADGE[meta.kind]}
          </span>
        )}

        {/* A clipboard write is invisible — without this the double-click
            that copied a color looks like a double-click that did
            nothing. */}
        {copied && (
          <span className="absolute inset-0 z-10 grid place-items-center bg-black/45">
            <span className="rounded-full bg-white/90 px-2.5 py-1 text-[11px] font-semibold text-black">
              Copied
            </span>
          </span>
        )}

        <SelectCheckbox id={meta.id} className="absolute left-1.5 top-1.5 z-20" />
      </div>

      <div className="px-0.5 pt-2">
        <p
          className="truncate text-[12.5px] font-semibold text-[var(--color-ink)]"
          title={meta.title}
        >
          {meta.title}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-[var(--color-hint)]">
          {subtitle}
        </p>
        <div className="mt-1 flex h-6 items-center justify-between">
          <span className="text-[11px] text-[var(--color-hint)]">
            {formatTime(meta.createdAtMs)}
          </span>
          <span className="flex items-center">
            {mode === "library" && <FavoriteButton meta={meta} />}
            <CaptureMenu
              meta={meta}
              mode={mode}
              onDelete={onDelete}
              onRestore={onRestore}
              onPurge={onPurge}
            />
          </span>
        </div>
      </div>
    </motion.div>
  );
}
