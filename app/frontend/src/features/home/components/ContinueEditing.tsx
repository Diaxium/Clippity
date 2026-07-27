/**
 * "Continue editing" card — a resume list of recent captures (editor
 * exports first). Each row, and "View all", opens the capture in the
 * Editor.
 */

import { MoreHorizontal } from "lucide-react";

import type { CaptureKind, CaptureMeta } from "@services/tauri/clients/library";
import { cn } from "@shared/lib/cn";

import { formatDimensions, formatRelative } from "../lib/format";
import { CaptureThumb } from "./CaptureThumb";
import { CardEmpty, LinkAction, SectionCard, SectionHeading } from "./primitives";

const KIND_LABEL: Record<CaptureKind, string> = {
  image: "Image",
  video: "Video",
  gif: "GIF",
  color: "Color",
  palette: "Palette",
  text: "Text",
};

/** "Image · 2560×1440" — kind plus dimensions when known. */
function metaLine(c: CaptureMeta): string {
  return [KIND_LABEL[c.kind], formatDimensions(c.width, c.height)]
    .filter(Boolean)
    .join(" · ");
}

interface ContinueEditingProps {
  items: CaptureMeta[];
  loading: boolean;
  onViewAll: () => void;
  onOpen: (id: string) => void;
}

export function ContinueEditing({
  items,
  loading,
  onViewAll,
  onOpen,
}: ContinueEditingProps) {
  return (
    <SectionCard>
      <SectionHeading
        title="Continue editing"
        action={<LinkAction label="View all" onClick={onViewAll} />}
      />
      {items.length === 0 ? (
        <CardEmpty>
          {loading ? "Loading…" : "Captures you edit will appear here."}
        </CardEmpty>
      ) : (
        <ul className="mt-3 flex flex-col">
          {items.map((item, i) => {
            const verb = item.mode === "Edited" ? "Edited" : "Captured";
            return (
              <li key={item.id}>
                <div
                  className={cn(
                    "group flex items-center gap-3 py-2.5",
                    i > 0 && "border-t border-[color:var(--hairline)]"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onOpen(item.id)}
                    className="focus-ring flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <CaptureThumb
                      id={item.id}
                      kind={item.kind}
                      maxWidth={120}
                      className="h-11 w-14 shrink-0 rounded-[8px] border border-[color:var(--hairline)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-[var(--color-ink)]">
                        {item.title}
                      </span>
                      <span className="block truncate text-[12px] text-[var(--color-slate)]">
                        {metaLine(item)}
                      </span>
                    </span>
                  </button>
                  <span className="hidden shrink-0 text-[12px] text-[var(--color-slate)] md:block">
                    {verb} {formatRelative(item.createdAtMs)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Open ${item.title} in the editor`}
                    onClick={() => onOpen(item.id)}
                    className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-[8px] text-[var(--color-slate)] transition-colors hover:bg-[var(--color-overlay-2)] hover:text-[var(--color-ink)]"
                  >
                    <MoreHorizontal size={17} strokeWidth={1.9} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
