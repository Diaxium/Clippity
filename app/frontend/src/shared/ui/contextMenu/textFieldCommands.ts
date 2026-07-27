import type { ContextMenuField } from "./types";

/**
 * Clipboard commands for the fallback menu over a text field.
 *
 * Two things make this fiddlier than it looks:
 *
 *  1. **The selection is gone by the time the item runs.** Opening the
 *     menu and clicking an entry moves focus off the field, so every
 *     command re-focuses the snapshot taken at right-click time and
 *     re-applies its range before doing anything.
 *  2. **React must see the edit.** Assigning `.value` bypasses React's
 *     value tracker and a controlled input silently reverts on the next
 *     render. `execCommand("insertText" | "cut")` goes through the
 *     browser's own editing pipeline, which emits the native `input`
 *     event React's `onChange` is built on, so controlled fields update
 *     for free. It is deprecated but is the only DOM API that does this,
 *     and Chromium (which is all WebView2 ever is here) still ships it.
 *
 * `execCommand("paste")` is blocked for pages regardless of gesture, so
 * paste reads the text itself and inserts it as a normal edit.
 */

export type TextFieldTarget = HTMLInputElement | HTMLTextAreaElement;

/** Input types that carry editable text worth a clipboard menu. */
const TEXTUAL_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
]);

/** The `<input>`/`<textarea>` at `el`, if it holds editable-ish text. */
export function asTextField(el: EventTarget | null): TextFieldTarget | null {
  if (!(el instanceof HTMLElement)) return null;
  if (el instanceof HTMLTextAreaElement) return el.disabled ? null : el;
  if (el instanceof HTMLInputElement) {
    if (el.disabled) return null;
    return TEXTUAL_INPUT_TYPES.has(el.type) ? el : null;
  }
  return null;
}

/** Snapshot of the caret/selection, taken while the field still has it. */
export function snapshotField(el: TextFieldTarget): ContextMenuField {
  return {
    el,
    start: el.selectionStart ?? 0,
    end: el.selectionEnd ?? 0,
  };
}

export function fieldHasSelection(field: ContextMenuField): boolean {
  return field.end > field.start;
}

export function fieldIsEditable(field: ContextMenuField): boolean {
  return !field.el.readOnly && !field.el.disabled;
}

/** Re-focus the field and restore the range captured at right-click. */
function restore(field: ContextMenuField): void {
  const { el, start, end } = field;
  el.focus({ preventScroll: true });
  try {
    el.setSelectionRange(start, end);
  } catch {
    // `setSelectionRange` throws on input types that don't support it
    // (e.g. a `number` field in some engines). The command below still
    // operates on whatever the browser considers selected.
  }
}

export function cutField(field: ContextMenuField): void {
  restore(field);
  document.execCommand("cut");
}

export function copyField(field: ContextMenuField): void {
  restore(field);
  if (document.execCommand("copy")) return;
  // Fallback for engines that refuse the legacy command — the async
  // clipboard write doesn't need the field to be focused.
  const text = field.el.value.slice(field.start, field.end);
  if (text) void navigator.clipboard?.writeText(text).catch(() => {});
}

export async function pasteIntoField(field: ContextMenuField): Promise<void> {
  restore(field);
  const text = await navigator.clipboard?.readText().catch(() => "");
  if (!text) return;
  restore(field);
  document.execCommand("insertText", false, text);
}

export function selectAllInField(field: ContextMenuField): void {
  field.el.focus({ preventScroll: true });
  field.el.select();
}
