/**
 * Tiny conditional-classname helper. Joins truthy string args with a
 * space; ignores falsy values. Kept dependency-free (no clsx/twMerge)
 * because every component uses it and the legacy version was 4 lines.
 *
 * If we later need conflict-aware merging (tw-merge), bump this up
 * rather than introducing a second helper.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    out = out ? `${out} ${part}` : part;
  }
  return out;
}
