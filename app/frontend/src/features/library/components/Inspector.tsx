import { useEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";

import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Folder,
  FolderPlus,
  Link2,
  Maximize2,
  PenLine,
  Plus,
  RotateCcw,
  Share2,
  Trash2,
  X,
} from "lucide-react";

import {
  collectionsAddMembers,
  collectionsRemoveMembers,
} from "@services/tauri/clients/collections";
import { openDashboard } from "@services/tauri/clients/dashboard";
import { openInEditor } from "@services/tauri/clients/editor";
import { shareCapture, type ShareTarget } from "@services/tauri/clients/share";
import { emitErrorToast } from "@services/tauri/clients/toast";
import { cn } from "@shared/lib/cn";

import { INSPECTOR_W, THUMBNAIL_INSPECTOR_W } from "../constants";
import { useThumbnail } from "../hooks/useThumbnail";
import { copyAux } from "../lib/auxClipboard";
import { formatBytes, formatDimensions, formatTime } from "../lib/format";
import { KIND_BADGE } from "../modes";
import type { CaptureMeta, Collection, LibraryMode } from "../types";
import { AuxDetails } from "./AuxDetails";
import { AuxPreview } from "./AuxPreview";
import { FavoriteButton } from "./FavoriteButton";
import { PalettePreview } from "./PalettePreview";
import { TagEditor, tagsOf } from "./TagEditor";

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;

interface InspectorProps {
  meta: CaptureMeta;
  mode: LibraryMode;
  collections: Collection[];
  /** Every tag in use — the tag editor's vocabulary. */
  suggestions: string[];
  onDelete: (m: CaptureMeta) => void;
  onRestore: (m: CaptureMeta) => void;
  onPurge: (m: CaptureMeta) => void;
  onClose: () => void;
  className?: string;
}

/**
 * The details pane: everything known about one capture, and everything
 * that can be done to it.
 *
 * It exists because a grid card can only carry what fits under a
 * thumbnail — a title, a time, two tags — while a capture actually knows
 * where it came from, which window, which display, and which preset. All
 * of that used to be crammed into one hover tooltip
 * (`formatProvenance`), which is fine for a glance and useless for
 * comparing two captures. Here it is a table.
 *
 * Four blocks, in the order a person asks for them: what it *is*
 * (preview, name, tags), what is *true* of it (information), where it
 * has been *filed* (collections), and what to *do* with it (actions).
 * Nothing in here is a placeholder — every row calls a command that
 * exists, which is why there is no "Export" or "Duplicate" among them.
 */
export function Inspector({
  meta,
  mode,
  collections,
  suggestions,
  onDelete,
  onRestore,
  onPurge,
  onClose,
  className,
}: InspectorProps) {
  const isAux =
    meta.kind === "color" || meta.kind === "palette" || meta.kind === "text";
  const isPalette = meta.kind === "palette" && !!meta.palette?.length;
  // No ref: the pane is small and always on screen when mounted, so the
  // grid's lazy intersection gate would only add a frame of blank.
  const thumb = useThumbnail(null, isAux ? null : meta.id, THUMBNAIL_INSPECTOR_W);
  const dimensions = formatDimensions(meta.width, meta.height);
  const created = new Date(meta.createdAtMs);

  const member = collections.filter((c) => c.members.includes(meta.id));
  const nonMember = collections.filter((c) => !c.members.includes(meta.id));

  const share = (target: ShareTarget) => {
    void shareCapture(meta.id, target).catch((err: unknown) =>
      emitErrorToast(
        err instanceof Error ? err.message : "Failed to open the capture."
      )
    );
  };

  return (
    <aside
      style={{ width: INSPECTOR_W }}
      aria-label="Capture details"
      className={cn(
        "shrink-0 flex-col overflow-hidden border-l border-[color:var(--hairline)] bg-[var(--color-surface)]",
        className
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3.5">
        {/* Preview */}
        <div className="relative aspect-video w-full overflow-hidden rounded-[12px] border border-[color:var(--hairline)] bg-[var(--color-surface-2)]">
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
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            title="Close details"
            className="focus-ring absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-[7px] bg-black/45 text-white transition-colors hover:bg-black/65"
          >
            <X size={12} strokeWidth={2.4} />
          </button>
        </div>

        {/* Identity */}
        <div className="mt-3 flex items-center gap-2">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] bg-[color:var(--color-overlay-1)] text-[9px] font-bold tracking-tight text-[var(--color-slate)]">
            {KIND_BADGE[meta.kind] ?? "?"}
          </span>
          <p
            className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-[var(--color-ink)]"
            title={meta.title}
          >
            {meta.title}
          </p>
          {mode === "library" && <FavoriteButton meta={meta} alwaysVisible />}
        </div>

        {/* Tags — the editor is the same popover the cards use, so a tag
            added here and one added there cannot diverge. */}
        {mode === "library" && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1 rounded-[10px] border border-dashed border-[color:var(--hairline-strong)] p-1.5">
            {tagsOf(meta).length === 0 && (
              <span className="px-1.5 text-[11.5px] text-[var(--color-hint)]">
                No tags yet
              </span>
            )}
            {tagsOf(meta).map((tag) => (
              <span
                key={tag}
                className="max-w-full truncate rounded-full bg-[color:var(--color-overlay-1)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-slate)]"
              >
                {tag}
              </span>
            ))}
            <span className="ml-auto">
              <TagEditor
                ids={[meta.id]}
                current={tagsOf(meta)}
                suggestions={suggestions}
                compact
              />
            </span>
          </div>
        )}

        {/* An aux entry's content is the thing the user came for, so it
            sits above the metadata table rather than under it. */}
        <AuxDetails meta={meta} />

        {/* Information */}
        <SectionLabel>Information</SectionLabel>
        <dl className="flex flex-col">
          <Fact label="Type" value={KIND_BADGE[meta.kind] ?? meta.kind} />
          {dimensions && <Fact label="Dimensions" value={dimensions} />}
          {!isAux && <Fact label="File size" value={formatBytes(meta.sizeBytes)} />}
          <Fact
            label="Created"
            value={`${created.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })} at ${formatTime(meta.createdAtMs)}`}
          />
          {meta.mode && <Fact label="Capture mode" value={meta.mode} />}
          {meta.sourceApp && <Fact label="Source app" value={meta.sourceApp} />}
          {meta.sourceWindow && (
            <Fact label="Window" value={meta.sourceWindow} />
          )}
          {meta.monitor && <Fact label="Display" value={meta.monitor} />}
          {meta.preset && <Fact label="Preset" value={meta.preset} />}
        </dl>

        {/* Collections — membership, and the shortest path into another. */}
        {mode === "library" && (
          <>
            <SectionLabel>Collections</SectionLabel>
            {member.map((c) => (
              <div
                key={c.id}
                className="group/col flex h-8 items-center gap-2 rounded-[8px] px-2 text-[12.5px] text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)]"
              >
                <Folder size={14} strokeWidth={1.75} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <button
                  type="button"
                  aria-label={`Remove from ${c.name}`}
                  title={`Remove from ${c.name}`}
                  onClick={() => {
                    void collectionsRemoveMembers(c.id, [meta.id]).catch(
                      (err: unknown) =>
                        emitErrorToast(
                          err instanceof Error
                            ? err.message
                            : "Failed to remove from the collection."
                        )
                    );
                  }}
                  className="focus-ring hidden h-5 w-5 place-items-center rounded-[6px] text-[var(--color-hint)] hover:text-[var(--color-ink)] group-hover/col:grid"
                >
                  <X size={12} strokeWidth={2.2} />
                </button>
              </div>
            ))}
            <AddToCollection
              options={nonMember}
              onPick={(c) => {
                void collectionsAddMembers(c.id, [meta.id]).catch(
                  (err: unknown) =>
                    emitErrorToast(
                      err instanceof Error
                        ? err.message
                        : "Failed to add to the collection."
                    )
                );
              }}
            />
          </>
        )}

        {/* Actions */}
        <SectionLabel>Actions</SectionLabel>
        {mode === "trash" ? (
          <>
            <Action
              icon={RotateCcw}
              label="Restore"
              onClick={() => onRestore(meta)}
            />
            <Action
              icon={Trash2}
              label="Delete permanently"
              danger
              onClick={() => onPurge(meta)}
            />
          </>
        ) : (
          <>
            {isAux ? (
              isPalette ? (
                // A palette's copy affordances all live in the swatch
                // block above (per-swatch, plus six export formats), so
                // the only action left is the one this pane can't do:
                // the full-size view.
                <Action
                  icon={Maximize2}
                  label="Open palette view"
                  onClick={() => void openDashboard("palette", meta.id)}
                />
              ) : (
                <Action
                  icon={Copy}
                  label="Copy to clipboard"
                  onClick={() => {
                    void copyAux(meta).then((ok) => {
                      if (!ok) void emitErrorToast("Nothing to copy.");
                    });
                  }}
                />
              )
            ) : (
              <>
                {/* A recording has no editor to open — the annotation
                    editor loads a capture as an image, and a video is
                    not one. "Open in default app" is a recording's play
                    button. */}
                {meta.kind === "video" ? null : (
                  <Action
                    icon={PenLine}
                    label="Open in editor"
                    onClick={() => {
                      void openInEditor(meta.id).catch((err: unknown) =>
                        emitErrorToast(
                          err instanceof Error
                            ? err.message
                            : "Failed to open editor."
                        )
                      );
                    }}
                  />
                )}
                <Action
                  icon={ExternalLink}
                  label={meta.kind === "video" ? "Play" : "Open in default app"}
                  onClick={() => share("open")}
                />
                <Action
                  icon={Folder}
                  label="Reveal in folder"
                  onClick={() => share("reveal")}
                />
                <Action
                  icon={Link2}
                  label="Copy file path"
                  onClick={() => share("copy-path")}
                />
              </>
            )}
            <Action
              icon={Trash2}
              label="Move to trash"
              danger
              onClick={() => onDelete(meta)}
            />
          </>
        )}
      </div>

      {/* The one action worth a button rather than a row — getting the
          capture out of Clippity and into whatever the user meant to put
          it in. Aux entries have no file to reveal, so they get their
          copy instead. */}
      <div className="border-t border-[color:var(--hairline)] p-3">
        {isPalette ? (
          <PrimaryButton
            icon={Maximize2}
            label="Open palette"
            onClick={() => void openDashboard("palette", meta.id)}
          />
        ) : isAux ? (
          <PrimaryButton
            icon={Copy}
            label="Copy"
            onClick={() => {
              void copyAux(meta).then((ok) => {
                if (!ok) void emitErrorToast("Nothing to copy.");
              });
            }}
          />
        ) : (
          <PrimaryButton
            icon={Share2}
            label="Share"
            onClick={() => share("reveal")}
            menu={[
              { label: "Reveal in folder", onClick: () => share("reveal") },
              { label: "Open in default app", onClick: () => share("open") },
              { label: "Copy file path", onClick: () => share("copy-path") },
            ]}
          />
        )}
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-hint)]">
      {children}
    </p>
  );
}

/** One row of the information table. The value is allowed to wrap — a
 *  window title is often long, and truncating the single most
 *  identifying fact to `Untitled — Goog…` defeats the point of the
 *  pane. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-[3px]">
      <dt className="shrink-0 text-[12px] text-[var(--color-slate)]">{label}</dt>
      <dd
        className="min-w-0 text-right text-[12px] text-[var(--color-ink)]"
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function Action({
  icon: Icon,
  label,
  onClick,
  danger = false,
}: {
  icon: Icon;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "focus-ring flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[12.5px] transition-colors",
        danger
          ? "text-[var(--ed-danger,#f24822)] hover:bg-[color:var(--color-overlay-1)]"
          : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
      )}
    >
      <Icon size={14} strokeWidth={1.85} />
      {label}
    </button>
  );
}

/** "Add to collection" — a row that becomes a picker. Collapsed when
 *  there is nowhere left to add it, since an empty menu is a dead end. */
function AddToCollection({
  options,
  onPick,
}: {
  options: Collection[];
  onPick: (c: Collection) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
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

  if (options.length === 0) {
    return (
      <p className="px-2 py-1 text-[11.5px] text-[var(--color-hint)]">
        In every collection.
      </p>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="focus-ring flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[12.5px] text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
      >
        <Plus size={14} strokeWidth={2} />
        Add to collection
        <ChevronRight
          size={13}
          strokeWidth={1.85}
          className="ml-auto text-[var(--color-hint)]"
        />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Add to collection"
          className="clippity-menu absolute left-0 right-0 top-full z-30 mt-1 max-h-52 overflow-y-auto rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-medium)]"
        >
          {options.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(c);
              }}
              className="focus-ring flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12.5px] text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
            >
              <FolderPlus size={13} strokeWidth={1.75} className="shrink-0" />
              <span className="truncate">{c.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Accent CTA, optionally split: the main half does the likeliest thing,
 *  the chevron lists the rest. */
function PrimaryButton({
  icon: Icon,
  label,
  onClick,
  menu,
}: {
  icon: Icon;
  label: string;
  onClick: () => void;
  menu?: { label: string; onClick: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center overflow-hidden rounded-[10px]">
        <button
          type="button"
          onClick={onClick}
          className="focus-ring inline-flex h-9 flex-1 items-center justify-center gap-2 bg-[var(--color-accent)] text-[13px] font-semibold text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]"
        >
          <Icon size={15} strokeWidth={2} />
          {label}
        </button>
        {menu && (
          <>
            <span className="h-9 w-px bg-black/15" />
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label={`More ${label.toLowerCase()} options`}
              aria-expanded={open}
              className="focus-ring grid h-9 w-8 place-items-center bg-[var(--color-accent)] text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]"
            >
              <ChevronDown size={14} strokeWidth={2.2} />
            </button>
          </>
        )}
      </div>
      {menu && open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 right-0 z-30 mb-1.5 rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-medium)]"
        >
          {menu.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className="focus-ring w-full truncate rounded-[7px] px-2 py-1.5 text-left text-[12.5px] text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
