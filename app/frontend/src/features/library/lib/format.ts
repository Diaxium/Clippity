/**
 * Pure formatting helpers for the library view. Extracted from the
 * legacy `LibraryView.tsx` (which inlined them) so they're unit-
 * testable in isolation. No React, no IPC.
 */

import { KIND_BADGE } from "../modes";
import type { CaptureMeta } from "../types";

/** Human-readable byte size: B / KB / MB / GB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** 12-hour clock with AM/PM, e.g. "3:07 PM". Empty string for a
 *  zero/falsy timestamp. */
export function formatTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

/** Pixel dimensions as `1920×1080`, or `""` when either is missing.
 *  Uses `×` (U+00D7), not the letter x. */
export function formatDimensions(width?: number, height?: number): string {
  if (!width || !height) return "";
  return `${width}×${height}`;
}

/**
 * The full provenance of a capture as one hover string — window title,
 * source app, capture mode, dimensions, display, preset — skipping
 * whatever the backend couldn't resolve.
 *
 * A tooltip rather than a visible line on purpose: a window title is
 * often paragraph-long, so putting it in the card would either truncate
 * to uselessness or wreck the grid. The card shows the short, stable
 * part (the app); this is what you get for asking.
 *
 * Ordered narrowest-to-widest — the window, then what owned it, then how
 * and where it was taken — so the parts a capture is most likely to have
 * lead, and the tail simply stops early on a sparse record.
 *
 * Returns `""` when nothing is known, so a caller can pass it straight
 * to `title=` and get no tooltip at all rather than an empty box.
 */
export function formatProvenance(meta: {
  sourceApp?: string;
  sourceWindow?: string;
  mode?: string;
  width?: number;
  height?: number;
  monitor?: string;
  preset?: string;
}): string {
  const dimensions = formatDimensions(meta.width, meta.height);
  return [
    meta.sourceWindow,
    meta.sourceApp,
    meta.mode,
    dimensions,
    meta.monitor,
    meta.preset,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(" · ");
}

/** Size of a text entry, for the card line and the details pane. */
export interface TextStats {
  characters: number;
  words: number;
  lines: number;
}

/**
 * Measure a text entry. Words are whitespace-separated runs, so a blank
 * or whitespace-only entry counts zero rather than one — `"".split(/\s+/)`
 * yields `[""]`, which is the classic off-by-one here.
 */
export function textStats(text: string): TextStats {
  const trimmed = text.trim();
  return {
    characters: text.length,
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    lines: text.split("\n").length,
  };
}

/**
 * What this capture *is*, in the terms its own kind is measured in.
 *
 * A screenshot is described by its pixels (`1920×1080`); a palette by
 * how many colors it holds; a text entry by how much text. Falling back
 * to dimensions for all six would leave every aux entry describing
 * itself as `""` — the ones that most need a word of description would
 * get the least.
 *
 * A color is described by its **RGB**, not its hex, because the backend
 * already titles a color entry with its hex: printing it again under
 * itself would spend the one spare line on a repetition. The second
 * notation is the one thing a glance at the card can't otherwise give.
 *
 * Returns `""` when the detail is missing (a color entry whose payload
 * didn't survive), so callers can drop the line rather than print a
 * label with nothing after it.
 */
export function captureDetail(meta: CaptureMeta): string {
  switch (meta.kind) {
    case "color":
      return meta.color
        ? `rgb(${meta.color.r}, ${meta.color.g}, ${meta.color.b})`
        : "";
    case "palette": {
      const n = meta.palette?.length ?? 0;
      return n ? `${n} color${n === 1 ? "" : "s"}` : "";
    }
    case "text": {
      if (!meta.text) return "";
      const { words } = textStats(meta.text);
      return `${words.toLocaleString()} word${words === 1 ? "" : "s"}`;
    }
    default:
      return formatDimensions(meta.width, meta.height);
  }
}

/**
 * The line under a card's title: the kind badge, then the detail.
 *
 * The card has no badge chip of its own for most kinds, so it carries
 * the kind here; the list row already shows one at the end of the row
 * and uses `captureDetail` alone. Never emits a dangling separator.
 */
export function captureSubtitle(meta: CaptureMeta): string {
  const badge = KIND_BADGE[meta.kind] ?? meta.kind.toUpperCase();
  const detail = captureDetail(meta);
  return detail ? `${badge} • ${detail}` : badge;
}

/** Epoch-ms for local midnight of the day containing `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Day-group key (local midnight epoch-ms). Captures taken on the
 *  same calendar day share a key. */
export function dayKey(ms: number): number {
  return startOfDay(ms);
}

/** Relative day heading: Today / Yesterday / weekday name (within a
 *  week) / formatted date. */
export function dayLabel(ms: number, now: number = Date.now()): string {
  const today = startOfDay(now);
  const day = startOfDay(ms);
  const diff = Math.round((today - day) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff > 1 && diff < 7) {
    return new Date(ms).toLocaleDateString(undefined, { weekday: "long" });
  }
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
