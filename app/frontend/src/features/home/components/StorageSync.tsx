/**
 * "Storage" card — live captures-dir usage.
 *
 * `library_storage` gives a real used/total byte reading (a fixed
 * display cap), rendered as a meter; the rows below show the live
 * capture count and the save location. (The reference's "cloud backup /
 * auto-delete / synced" rows are omitted — there is no sync backend, and
 * a hardcoded "Synced" badge would be fiction.)
 */

import { HardDrive } from "lucide-react";

import type { StorageInfo } from "@services/tauri/clients/library";

import { formatBytes } from "../lib/format";
import { SectionCard, SectionHeading } from "./primitives";

interface StorageCardProps {
  info: StorageInfo | null;
  percent: number;
  count: number;
  /** Save-folder basename, or null for the default captures dir. */
  location: string | null;
}

export function StorageCard({
  info,
  percent,
  count,
  location,
}: StorageCardProps) {
  const used = formatBytes(info?.usedBytes ?? 0);
  const total = formatBytes(info?.totalBytes ?? 0);

  return (
    <SectionCard>
      <SectionHeading
        title="Storage"
        action={
          <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--color-slate)]">
            <HardDrive size={15} strokeWidth={2} />
            Local
          </span>
        }
      />

      <p className="mt-4 text-[12.5px] text-[var(--color-slate)]">
        Captures folder
      </p>
      <div className="mt-1 flex items-baseline justify-between">
        <p className="text-[15px] font-semibold text-[var(--color-ink)]">
          {used}{" "}
          <span className="text-[12.5px] font-normal text-[var(--color-slate)]">
            used of {total}
          </span>
        </p>
        <span className="text-[12.5px] font-medium text-[var(--color-slate)]">
          {percent}%
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-overlay-2)]">
        <div
          className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-[color:var(--hairline)] pt-4">
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-[var(--color-ink)]">Captures</span>
          <span className="text-[12.5px] font-medium text-[var(--color-slate)]">
            {count.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-[var(--color-ink)]">Location</span>
          <span
            className="min-w-0 truncate text-[12.5px] font-medium text-[var(--color-slate)]"
            title={location ?? "Default folder"}
          >
            {location ?? "Default folder"}
          </span>
        </div>
      </div>
    </SectionCard>
  );
}
