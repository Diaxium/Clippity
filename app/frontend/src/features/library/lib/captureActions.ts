import {
  Copy,
  ExternalLink,
  Folder,
  Maximize2,
  PenLine,
  RotateCcw,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";

import { openDashboard } from "@services/tauri/clients/dashboard";
import { openInEditor } from "@services/tauri/clients/editor";
import { shareCapture, type ShareTarget } from "@services/tauri/clients/share";
import { emitErrorToast } from "@services/tauri/clients/toast";
import type { ContextMenuEntry } from "@shared/ui/contextMenu";

import { copyAux } from "./auxClipboard";
import { setFavorite } from "./labelActions";
import type { CaptureMeta, LibraryMode } from "../types";

/**
 * The one definition of "what can be done to a capture".
 *
 * Both the card's overflow button (`CaptureMenu`) and right-clicking the
 * card or row render this list, so the two can't drift into offering
 * different commands for the same capture — which is exactly the bug a
 * second, hand-written context menu would have introduced.
 *
 * The set is kind-dependent on purpose: a color or a text run has no
 * editor to open and no file to reveal, so offering those would be four
 * dead entries out of five. See `CaptureCard`'s note on why "open" means
 * the terminal act for the kind rather than one fixed destination.
 */
export interface CaptureActionHandlers {
  onDelete: (m: CaptureMeta) => void;
  onRestore: (m: CaptureMeta) => void;
  onPurge: (m: CaptureMeta) => void;
}

export function captureActionEntries(
  meta: CaptureMeta,
  mode: LibraryMode,
  handlers: CaptureActionHandlers,
  /** The overflow button sits beside a `FavoriteButton`, so it leaves the
   *  star out; a right-click has no such neighbour and includes it. */
  options: { includeFavorite?: boolean } = {}
): ContextMenuEntry[] {
  const share = (target: ShareTarget) => () =>
    void shareCapture(meta.id, target).catch((err: unknown) =>
      emitErrorToast(
        err instanceof Error ? err.message : "Failed to open the capture."
      )
    );

  if (mode === "trash") {
    return [
      {
        id: "restore",
        label: "Restore",
        icon: RotateCcw,
        onSelect: () => handlers.onRestore(meta),
      },
      "divider",
      {
        id: "purge",
        label: "Delete permanently",
        icon: Trash2,
        danger: true,
        onSelect: () => handlers.onPurge(meta),
      },
    ];
  }

  const isAux =
    meta.kind === "color" || meta.kind === "palette" || meta.kind === "text";
  const isPalette = meta.kind === "palette" && !!meta.palette?.length;
  // A recording has no editor to open — the annotation editor loads a
  // capture as an image, and a video is not one. Same reasoning that
  // keeps aux kinds out of it: a menu entry that always errors is worse
  // than an absent one. GIF stays in; it decodes as an image, and
  // flattening it there is a choice the user can make.
  const isVideo = meta.kind === "video";

  const entries: ContextMenuEntry[] = isAux
    ? [
        {
          id: "copy",
          label: isPalette ? "Copy hex list" : "Copy to clipboard",
          icon: Copy,
          onSelect: () => {
            void copyAux(meta).then((ok) => {
              if (!ok) void emitErrorToast("Nothing to copy.");
            });
          },
        },
      ]
    : [
        ...(isVideo
          ? []
          : [
              {
                id: "open-editor",
                label: "Open in editor",
                icon: PenLine,
                onSelect: () => {
                  void openInEditor(meta.id).catch((err: unknown) =>
                    emitErrorToast(
                      err instanceof Error
                        ? err.message
                        : "Failed to open editor."
                    )
                  );
                },
              } satisfies ContextMenuEntry,
            ]),
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

  // The full-size view is where a palette's swatches get picked apart;
  // the other export formats live in the details pane.
  if (isPalette) {
    entries.push({
      id: "open-palette",
      label: "Open palette view",
      icon: Maximize2,
      onSelect: () => void openDashboard("palette", meta.id),
    });
  }

  if (options.includeFavorite) {
    const favorite = meta.favorite === true;
    entries.push({
      id: "favorite",
      label: favorite ? "Remove from favorites" : "Add to favorites",
      icon: favorite ? StarOff : Star,
      // Fire-and-forget like `FavoriteButton`: the backend's
      // `library/updated` event brings the new state back, so there is no
      // second source of truth to keep in step here.
      onSelect: () => void setFavorite([meta.id], !favorite),
    });
  }

  entries.push("divider", {
    id: "trash",
    label: "Move to trash",
    icon: Trash2,
    danger: true,
    onSelect: () => handlers.onDelete(meta),
  });

  return entries;
}
