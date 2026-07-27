/**
 * "Recent activity" card — a compact log of the newest captures. "View
 * all" jumps to the Library.
 */

import { Film, Image as ImageIcon } from "lucide-react";

import type { CaptureKind, CaptureMeta } from "@services/tauri/clients/library";

import { formatRelative } from "../lib/format";
import { tintForIndex, type IconComponent } from "../types";
import { CardEmpty, IconTile, LinkAction, SectionCard, SectionHeading } from "./primitives";

const KIND_ICON: Partial<Record<CaptureKind, IconComponent>> = {
  image: ImageIcon,
  video: Film,
  gif: Film,
};

interface RecentActivityProps {
  items: CaptureMeta[];
  loading: boolean;
  onViewAll: () => void;
}

export function RecentActivity({
  items,
  loading,
  onViewAll,
}: RecentActivityProps) {
  return (
    <SectionCard>
      <SectionHeading
        title="Recent activity"
        action={<LinkAction label="View all" onClick={onViewAll} />}
      />
      {items.length === 0 ? (
        <CardEmpty>{loading ? "Loading…" : "No activity yet."}</CardEmpty>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {items.map((item, i) => {
            const verb = item.mode === "Edited" ? "Edited" : "Captured";
            return (
              <li key={item.id} className="flex items-center gap-3">
                <IconTile
                  icon={KIND_ICON[item.kind] ?? ImageIcon}
                  tint={tintForIndex(i)}
                  size={32}
                  iconSize={15}
                />
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] font-medium text-[var(--color-ink)]">
                    {item.title}
                  </p>
                  <p className="text-[11.5px] text-[var(--color-slate)]">
                    {verb} {formatRelative(item.createdAtMs)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
