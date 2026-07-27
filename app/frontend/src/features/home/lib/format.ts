/**
 * Pure formatting helpers for the Home view. No React, no IPC — unit-
 * testable in isolation. Kept home-local (rather than reaching into the
 * library feature's `lib/format`) so the Home view owns its own display
 * rules and the two can diverge without a shared-file tug of war.
 */

/**
 * Compact "time since" label: `just now`, `5m ago`, `3h ago`,
 * `Yesterday`, `4d ago`, then a short date. `now` is injectable so the
 * function stays pure and testable (callers pass `Date.now()`).
 */
export function formatRelative(ms: number, now: number = Date.now()): string {
  if (!ms) return "";
  const diff = Math.max(0, now - ms);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;

  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return "Yesterday";
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;

  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Human-readable byte size: `B` / `KB` / `MB` / `GB`. */
export function formatBytes(n: number): string {
  if (n <= 0) return "0 MB";
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Pixel dimensions as `1920×1080`, or `""` when either is missing. */
export function formatDimensions(width?: number, height?: number): string {
  if (!width || !height) return "";
  return `${width}×${height}`;
}
