/**
 * Library kind-tab metadata + per-kind badge labels. Pure data, no
 * React. File-backed kinds + the armed aux kinds (color / palette); the
 * `text` tab joins when the grab-text (OCR) port lands.
 */

import type { CaptureKind, KindTab } from "./types";

export interface KindTabDef {
  id: KindTab;
  label: string;
}

/** Tab strip above the grid. Order matches the legacy. */
export const KIND_TABS: readonly KindTabDef[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "video", label: "Videos" },
  { id: "gif", label: "GIFs" },
  { id: "color", label: "Colors" },
  { id: "palette", label: "Palettes" },
  { id: "text", label: "Text" },
];

/** Short uppercase badge per kind, shown on cards + rows. */
export const KIND_BADGE: Record<CaptureKind, string> = {
  image: "PNG",
  video: "MP4",
  gif: "GIF",
  color: "HEX",
  palette: "PAL",
  text: "TXT",
};
