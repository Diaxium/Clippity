import type { RecentCapture } from "../types";
import { RecentThumb } from "./RecentThumb";

interface RecentCapturesProps {
  recents: RecentCapture[];
  loading: boolean;
  onOpen: (id: string) => void;
}

/**
 * The "Recent" strip — up to four latest image captures as thumbnails.
 * Falls back to a dashed empty state ("Loading…" / "No captures yet").
 */
export function RecentCaptures({
  recents,
  loading,
  onOpen,
}: RecentCapturesProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="px-0.5 text-[11px] font-semibold tracking-[0.06em] text-[var(--color-hint)] uppercase">
        Recent
      </span>
      {recents.length === 0 ? (
        <div className="grid h-[68px] place-items-center rounded-[12px] border border-dashed border-[color:var(--hairline-strong)] text-[12px] text-[var(--color-hint)]">
          {loading ? "Loading…" : "No captures yet"}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-1.5">
          {recents.map((r) => (
            <RecentThumb key={r.id} recent={r} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}
