import type { CaptureMeta } from "../types";

/**
 * The clipboard text for an aux (non-file) entry: a color's hex, a
 * palette's comma-separated hex list, or a text entry's content. Returns
 * `null` for file-backed entries (which copy nothing here). Pure.
 */
export function auxClipboardText(meta: CaptureMeta): string | null {
  switch (meta.kind) {
    case "color":
      return meta.color?.hex ?? null;
    case "palette":
      return meta.palette?.map((c) => c.hex).join(", ") ?? null;
    case "text":
      return meta.text ?? null;
    default:
      return null;
  }
}

/**
 * Copy an aux entry's value to the system clipboard (best-effort via the
 * webview Clipboard API). Resolves `false` when there's nothing to copy
 * or the write fails, so callers can surface feedback.
 */
export async function copyAux(meta: CaptureMeta): Promise<boolean> {
  const text = auxClipboardText(meta);
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
