/**
 * A capture thumbnail with a graceful fallback.
 *
 * Reuses the library feature's cached, lazy `useThumbnail` loader (one
 * shared module-level LRU across the whole app, so a thumbnail decoded
 * for the library grid is free here). When the decode returns nothing —
 * a browser preview with no backend, or a video/gif the backend won't
 * decode to a still — it renders a tinted tile with the kind's icon
 * instead of a broken image.
 */

import { useRef } from "react";

import { Film, Image as ImageIcon } from "lucide-react";

import { useThumbnail } from "@features/library/hooks/useThumbnail";
import type { CaptureKind } from "@services/tauri/clients/library";
import { cn } from "@shared/lib/cn";

import type { IconComponent } from "../types";

const KIND_ICON: Partial<Record<CaptureKind, IconComponent>> = {
  image: ImageIcon,
  video: Film,
  gif: Film,
};

interface CaptureThumbProps {
  id: string;
  kind: CaptureKind;
  /** Logical-pixel width requested from the decoder + cache key. */
  maxWidth?: number;
  className?: string;
}

export function CaptureThumb({
  id,
  kind,
  maxWidth = 320,
  className,
}: CaptureThumbProps) {
  const ref = useRef<HTMLDivElement>(null);
  const src = useThumbnail(ref, id, maxWidth);
  const Icon = KIND_ICON[kind] ?? ImageIcon;

  return (
    <div
      ref={ref}
      className={cn(
        "grid place-items-center overflow-hidden bg-[var(--color-overlay-2)]",
        className
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <Icon
          size={20}
          strokeWidth={1.75}
          className="text-[var(--color-hint)]"
        />
      )}
    </div>
  );
}
