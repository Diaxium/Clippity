/**
 * Which surface a file-backed capture opens on, and opening it there.
 *
 * **One definition, because this one drifted.** When Studio landed
 * (ADR 0032) the routing was added to the context menu and to the
 * Inspector, and missed on the card's own open — the double-click and
 * Enter path in `LibraryLayout`. Two of three call sites sent a
 * recording to Studio and the third sent it to the annotation editor,
 * which loads a capture as an image and refused the `.mp4` with a
 * decoder error. Nothing was wrong with the editor; it was asked the
 * wrong question.
 *
 * A rule copied into three components is a rule that will disagree with
 * itself, which is the same reasoning `captureActionEntries` gives for
 * being the only definition of what can be *done* to a capture. This is
 * the only definition of where it *opens*.
 */

import { Film, PenLine } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { openInEditor } from "@services/tauri/clients/editor";
import { openInStudio } from "@services/tauri/clients/media";
import { emitErrorToast } from "@services/tauri/clients/toast";

import type { CaptureMeta } from "../types";

/** The two surfaces a capture's file can open on. */
export type OpenSurface = "studio" | "editor";

/**
 * Where this capture opens.
 *
 * A recording goes to Studio: the annotation editor loads a capture as
 * an image and a video is not one. An animated GIF deliberately goes the
 * other way — it decodes as an image, so flattening it in the editor is
 * a choice the user can make, while Studio's decoder will not seek it.
 */
export function openSurfaceFor(meta: CaptureMeta): OpenSurface {
  return meta.kind === "video" ? "studio" : "editor";
}

/** How the open action is labelled for this capture. */
export function openLabelFor(meta: CaptureMeta): string {
  return openSurfaceFor(meta) === "studio"
    ? "Open in Studio"
    : "Open in editor";
}

/** The icon that goes with {@link openLabelFor}. */
export function openIconFor(meta: CaptureMeta): LucideIcon {
  return openSurfaceFor(meta) === "studio" ? Film : PenLine;
}

/**
 * Open a file-backed capture on its surface, surfacing a failure as a
 * toast.
 *
 * Callers that also handle the non-file kinds — a colour, a text run, a
 * palette — must resolve those before reaching here: this has no view to
 * offer them and would hand the editor an id with no image behind it.
 */
export function openCapture(meta: CaptureMeta): void {
  const surface = openSurfaceFor(meta);
  const open = surface === "studio" ? openInStudio : openInEditor;
  void open(meta.id).catch((err: unknown) =>
    emitErrorToast(
      err instanceof Error
        ? err.message
        : `Failed to open ${surface === "studio" ? "Studio" : "the editor"}.`
    )
  );
}
