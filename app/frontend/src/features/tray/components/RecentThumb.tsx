import { useCallback } from "react";

import { motion } from "motion/react";
import {
  ExternalLink,
  Folder,
  Image as ImageIcon,
  PenLine,
} from "lucide-react";

import { shareCapture, type ShareTarget } from "@services/tauri/clients/share";
import { emitErrorToast } from "@services/tauri/clients/toast";
import { useContextMenu } from "@shared/ui/contextMenu";

import type { RecentCapture } from "../types";

interface RecentThumbProps {
  recent: RecentCapture;
  onOpen: (id: string) => void;
}

/**
 * One recent-capture thumbnail. Opens the capture in the editor on
 * click; shows a placeholder glyph until its data URI has decoded.
 *
 * Right-click adds the two destinations the tile can't offer on its own.
 * The panel is a shortcut surface — a tile is 40px square and can carry
 * exactly one gesture — so "reveal in folder" would otherwise mean
 * opening the main window to do it.
 */
export function RecentThumb({ recent, onOpen }: RecentThumbProps) {
  const onContextMenu = useContextMenu(
    useCallback(() => {
      const share = (target: ShareTarget) => () =>
        void shareCapture(recent.id, target).catch((err: unknown) =>
          emitErrorToast(
            err instanceof Error ? err.message : "Failed to open the capture."
          )
        );
      return [
        {
          id: "open-editor",
          label: "Open in editor",
          icon: PenLine,
          onSelect: () => onOpen(recent.id),
        },
        {
          id: "open-default",
          label: "Open in default app",
          icon: ExternalLink,
          onSelect: share("open"),
        },
        {
          id: "reveal",
          label: "Reveal in folder",
          icon: Folder,
          onSelect: share("reveal"),
        },
      ];
    }, [recent.id, onOpen]),
    `Actions for ${recent.title}`
  );

  return (
    <motion.button
      type="button"
      onClick={() => onOpen(recent.id)}
      onContextMenu={onContextMenu}
      title={recent.title}
      aria-label={`Open ${recent.title} in editor`}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
      transition={{ duration: 0.16, ease: [0.4, 0, 0.2, 1] }}
      className="focus-ring no-drag aspect-square overflow-hidden rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-canvas-inset)] transition-shadow hover:shadow-[var(--shadow-medium)]"
    >
      {recent.thumb ? (
        <img
          src={recent.thumb}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <span className="grid h-full w-full place-items-center text-[var(--color-hint)]">
          <ImageIcon size={15} strokeWidth={1.9} />
        </span>
      )}
    </motion.button>
  );
}
