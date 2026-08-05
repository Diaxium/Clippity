/**
 * "Recent captures" card — a strip of the newest capture thumbnails with
 * name + relative time. Clicking a tile opens it in the editor; "View
 * all" jumps to the Library.
 */

import type { CaptureMeta } from "@services/tauri/clients/library";

import { formatRelative } from "../lib/format";
import { CaptureThumb } from "./CaptureThumb";
import {
  CardEmpty,
  LinkAction,
  SectionCard,
  SectionHeading,
} from "./primitives";

interface RecentCapturesProps {
  items: CaptureMeta[];
  loading: boolean;
  onViewAll: () => void;
  onOpen: (id: string) => void;
}

export function RecentCaptures({
  items,
  loading,
  onViewAll,
  onOpen,
}: RecentCapturesProps) {
  return (
    <SectionCard>
      <SectionHeading
        title="Recent captures"
        action={<LinkAction label="View all" onClick={onViewAll} />}
      />
      {items.length === 0 ? (
        <CardEmpty>
          {loading ? "Loading captures…" : "No captures yet."}
        </CardEmpty>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {items.map((capture) => (
            <button
              key={capture.id}
              type="button"
              onClick={() => onOpen(capture.id)}
              className="focus-ring group text-left"
              title={capture.title}
            >
              <CaptureThumb
                id={capture.id}
                kind={capture.kind}
                className="aspect-[4/3] w-full rounded-[10px] border border-[color:var(--hairline)] shadow-[var(--shadow-subtle)] transition-transform duration-200 group-hover:-translate-y-0.5"
              />
              <p className="mt-2 truncate text-[12.5px] font-medium text-[var(--color-ink)]">
                {capture.title}
              </p>
              <p className="text-[11.5px] text-[var(--color-slate)]">
                {formatRelative(capture.createdAtMs)}
              </p>
            </button>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
