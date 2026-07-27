/**
 * Human-readable byte formatting for component sizes, download sizes, and
 * disk-space figures. Uses decimal (MB / GB) units to match how Windows
 * and the design mockups present install sizes.
 */

const MB = 1_000_000;
const GB = 1_000_000_000;

/** Format a byte count as `"162 MB"`, `"2.1 GB"`, `"~ 310 MB"` etc. */
export function formatBytes(bytes: number, opts?: { approx?: boolean }): string {
  const prefix = opts?.approx ? "~ " : "";
  if (bytes >= GB) {
    // Always one decimal for GB (e.g. "2.1 GB", "14.5 GB") to match how
    // the design presents storage figures.
    const gb = Math.round((bytes / GB) * 10) / 10;
    return `${prefix}${gb} GB`;
  }
  const mb = Math.round(bytes / MB);
  return `${prefix}${mb} MB`;
}
