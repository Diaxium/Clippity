/**
 * The editor's default keybind map — a Figma + Illustrator hybrid. Pure data +
 * command closures over the store/api (no React). The hook installs one window
 * listener and dispatches into this list; the help overlay renders it; the
 * conflict checker validates it.
 *
 * Inspiration tags live in `docs/editor-keybinds.md`. Where Clippity already had
 * a tool letter that clashed with the "ideal" map (A = Arrow not Direct-Select,
 * I = Image not Eyedropper, M unused), the existing tool wins — muscle memory
 * and existing tests beat a letter, per the task's "map to the closest existing
 * tool" rule. Those deviations are documented, not silently dropped.
 */

import { TOOLS } from "../tools";
import { toolInMode } from "../types";
import type { CommandCtx, EditorKeybind } from "./keybindTypes";
import { tokenFromEvent } from "./keybindUtils";

/** Selected ids at dispatch time. */
const sel = (ctx: CommandCtx): string[] => ctx.store.selectedIds;

/** Arrow delta (×`step`) from the event's main key, or null for non-arrows —
 *  and null when there is no event at all (a non-keyboard invocation), which
 *  makes every arrow-driven command a safe no-op off the keyboard. */
function arrowDelta(
  ctx: CommandCtx,
  step: number
): { dx: number; dy: number } | null {
  if (!ctx.event) return null;
  switch (tokenFromEvent(ctx.event)) {
    case "arrowup":
      return { dx: 0, dy: -step };
    case "arrowdown":
      return { dx: 0, dy: step };
    case "arrowleft":
      return { dx: -step, dy: 0 };
    case "arrowright":
      return { dx: step, dy: 0 };
    default:
      return null;
  }
}

/** Tool shortcuts derived from the single source of truth ({@link TOOLS}), so
 *  the toolbar tooltip, the help overlay, and the binding never drift. */
const TOOL_KEYBINDS: EditorKeybind[] = TOOLS.filter((t) => t.shortcut).map(
  (t) => ({
    id: `tool-${t.id}`,
    // Labels already read as tools under the "Tools" help heading ("Move",
    // "Hand tool", "Text", …) — don't suffix another "tool".
    label: t.label,
    category: "tools",
    keys: [t.shortcut],
    onKeyDown: ({ store }) => {
      // Only switch to tools available in the current mode (Workstream M).
      if (toolInMode(t.id, store.mode)) store.setTool(t.id);
    },
  })
);

const ACTION_KEYBINDS: EditorKeybind[] = [
  // ---------------- Selection ----------------
  {
    id: "select-all",
    label: "Select all",
    category: "selection",
    keys: ["Mod+A"],
    onKeyDown: ({ store }) => store.selectAll(),
  },
  {
    id: "deselect-all",
    label: "Deselect all",
    category: "selection",
    keys: ["Mod+Shift+A"],
    onKeyDown: ({ store }) => store.clearSelection(),
  },
  {
    id: "delete",
    label: "Delete selection",
    category: "selection",
    keys: ["Delete", "Backspace"],
    helpKeys: ["Del", "⌫"],
    context: "selection",
    onKeyDown: ({ store }) => store.removeSelected(),
  },
  {
    id: "escape",
    label: "Cancel / deselect",
    category: "selection",
    keys: ["Escape"],
    // Cancel the most specific transient surface first, then clear selection.
    onKeyDown: ({ store }) => {
      if (store.cropSession) store.cancelCrop();
      else if (store.colorEditor) store.closeColorEditor();
      else if (store.contextMenu) store.closeContextMenu();
      else if (store.helpOpen) store.setHelpOpen(false);
      else store.clearSelection();
    },
  },
  // Crop clears the selection when it opens, so this `editor`-context Enter is
  // the one that resolves during a session — `enter-text-edit` below needs a
  // selection and is therefore inactive. Losing the session (Apply/Cancel/tool
  // change) hands Enter straight back to text editing.
  {
    id: "crop-apply",
    label: "Apply crop",
    category: "editing",
    keys: ["Enter"],
    onKeyDown: ({ store }) => {
      if (store.cropSession) store.commitCrop();
    },
  },
  {
    id: "enter-text-edit",
    label: "Edit text",
    category: "text",
    keys: ["Enter"],
    context: "selection",
    preventDefault: false,
    onKeyDown: (ctx) => {
      const ids = sel(ctx);
      const node = ids.length === 1 ? ctx.store.nodes[ids[0]!] : undefined;
      if (node?.type === "text") {
        ctx.event?.preventDefault();
        ctx.store.setEditingText(node.id);
      }
    },
  },

  // ---------------- Editing / history ----------------
  {
    id: "undo",
    label: "Undo",
    category: "editing",
    keys: ["Mod+Z"],
    onKeyDown: ({ store }) => store.undo(),
  },
  {
    id: "redo",
    label: "Redo",
    category: "editing",
    keys: ["Mod+Shift+Z", "Mod+Y"],
    onKeyDown: ({ store }) => store.redo(),
  },
  {
    id: "duplicate",
    label: "Duplicate",
    category: "editing",
    keys: ["Mod+D"],
    context: "selection",
    onKeyDown: (ctx) => ctx.store.duplicateNodes(sel(ctx)),
  },
  {
    id: "copy",
    label: "Copy",
    category: "editing",
    keys: ["Mod+C"],
    context: "selection",
    onKeyDown: (ctx) => ctx.store.copyNodes(sel(ctx)),
  },
  {
    id: "cut",
    label: "Cut",
    category: "editing",
    keys: ["Mod+X"],
    context: "selection",
    onKeyDown: (ctx) => {
      const ids = sel(ctx);
      ctx.store.copyNodes(ids);
      ctx.store.removeNodes(ids);
    },
  },
  {
    id: "paste",
    label: "Paste",
    category: "editing",
    keys: ["Mod+V"],
    onKeyDown: ({ store }) => store.pasteClipboard(),
  },
  {
    id: "nudge",
    label: "Nudge 1px",
    category: "editing",
    keys: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"],
    helpKeys: ["↑", "↓", "←", "→"],
    context: "selection",
    coalesce: true,
    // Direction comes from the event; there is no "nudge" without one.
    paletteHidden: true,
    onKeyDown: (ctx) => {
      const d = arrowDelta(ctx, 1);
      if (d) ctx.store.moveNodes(sel(ctx), d.dx, d.dy);
    },
  },
  {
    id: "nudge-big",
    label: "Nudge 10px",
    category: "editing",
    keys: [
      "Shift+ArrowUp",
      "Shift+ArrowDown",
      "Shift+ArrowLeft",
      "Shift+ArrowRight",
    ],
    helpKeys: ["⇧", "↑↓←→"],
    context: "selection",
    coalesce: true,
    paletteHidden: true,
    onKeyDown: (ctx) => {
      const d = arrowDelta(ctx, 10);
      if (d) ctx.store.moveNodes(sel(ctx), d.dx, d.dy);
    },
  },

  // ---------------- Layers ----------------
  {
    id: "bring-forward",
    label: "Bring forward",
    category: "layers",
    keys: ["Mod+]"],
    context: "selection",
    onKeyDown: (ctx) => ctx.store.bringForward(sel(ctx)),
  },
  {
    id: "bring-front",
    label: "Bring to front",
    category: "layers",
    keys: ["Mod+Shift+]"],
    context: "selection",
    onKeyDown: (ctx) => ctx.store.bringToFront(sel(ctx)),
  },
  {
    id: "send-backward",
    label: "Send backward",
    category: "layers",
    keys: ["Mod+["],
    context: "selection",
    onKeyDown: (ctx) => ctx.store.sendBackward(sel(ctx)),
  },
  {
    id: "send-back",
    label: "Send to back",
    category: "layers",
    keys: ["Mod+Shift+["],
    context: "selection",
    onKeyDown: (ctx) => ctx.store.sendToBack(sel(ctx)),
  },
  // Illustrator also offers Cmd+Alt+] / [ — kept as hidden aliases.
  {
    id: "bring-forward-alt",
    label: "Bring forward",
    category: "layers",
    keys: ["Mod+Alt+]"],
    context: "selection",
    hidden: true,
    onKeyDown: (ctx) => ctx.store.bringForward(sel(ctx)),
  },
  {
    id: "send-backward-alt",
    label: "Send backward",
    category: "layers",
    keys: ["Mod+Alt+["],
    context: "selection",
    hidden: true,
    onKeyDown: (ctx) => ctx.store.sendBackward(sel(ctx)),
  },
  {
    id: "lock",
    label: "Lock / unlock",
    category: "layers",
    keys: ["Mod+L"],
    context: "selection",
    onKeyDown: ({ store }) => store.toggleLockSelected(),
  },
  {
    id: "hide",
    label: "Hide / show",
    category: "layers",
    keys: ["Mod+Shift+L"],
    context: "selection",
    onKeyDown: ({ store }) => store.toggleHideSelected(),
  },
  // Grouping wraps the selection in a non-clipping frame (the scene's only
  // container type) — a pure tree restructure, since nodes carry absolute
  // coords (see editorStore.group/ungroup).
  {
    id: "group",
    label: "Group selection",
    category: "layers",
    keys: ["Mod+G"],
    context: "selection",
    onKeyDown: ({ store }) => store.group(),
  },
  {
    id: "ungroup",
    label: "Ungroup selection",
    category: "layers",
    keys: ["Mod+Shift+G"],
    context: "selection",
    onKeyDown: ({ store }) => store.ungroup(),
  },

  // ---------------- View ----------------
  {
    id: "zoom-in",
    label: "Zoom in",
    category: "view",
    keys: ["Mod+=", "Shift+="],
    helpKeys: ["Ctrl/⇧", "+"],
    onKeyDown: ({ store }) => store.zoomIn(),
  },
  {
    id: "zoom-out",
    label: "Zoom out",
    category: "view",
    keys: ["Mod+-", "Shift+-"],
    helpKeys: ["Ctrl/⇧", "−"],
    onKeyDown: ({ store }) => store.zoomOut(),
  },
  {
    id: "zoom-100",
    label: "Zoom to 100%",
    category: "view",
    keys: ["Mod+1"],
    onKeyDown: ({ store }) => store.resetZoom(),
  },
  {
    id: "zoom-fit",
    label: "Zoom to fit",
    category: "view",
    keys: ["Shift+1", "Mod+0"],
    onKeyDown: ({ store }) => store.fitView(),
  },
  {
    id: "zoom-selection",
    label: "Zoom to selection",
    category: "view",
    keys: ["Shift+2"],
    // No-op (non-blocking) when nothing is selected — fitSelection guards itself.
    onKeyDown: ({ store }) => store.fitSelection(),
  },
  {
    id: "temp-pan",
    label: "Pan (hold)",
    category: "view",
    keys: ["Space"],
    onKeyDown: ({ store }) => store.setTempPan(true),
    onKeyUp: ({ store }) => store.setTempPan(false),
    // A held key: invoking it from a palette would latch pan on with no keyup
    // to release it.
    paletteHidden: true,
  },
  {
    id: "help",
    label: "Show keyboard shortcuts",
    category: "view",
    keys: ["Shift+/"],
    helpKeys: ["?"],
    onKeyDown: ({ api }) => api.toggleHelp(),
  },

  // ---------------- Transform / resize ----------------
  {
    id: "resize-step",
    label: "Resize 1px (W / H)",
    category: "transform",
    keys: [
      "Mod+Shift+ArrowRight",
      "Mod+Shift+ArrowLeft",
      "Mod+Shift+ArrowDown",
      "Mod+Shift+ArrowUp",
    ],
    helpKeys: ["Ctrl", "⇧", "↑↓←→"],
    context: "selection",
    coalesce: true,
    paletteHidden: true,
    onKeyDown: (ctx) => {
      // Right/Left drive width; Down/Up drive height (matches the task map).
      const d = arrowDelta(ctx, 1);
      if (!d) return;
      ctx.store.resizeSelectedBy(d.dx, d.dy);
    },
  },
  {
    id: "resize-step-proportional",
    label: "Resize 1px proportionally",
    category: "transform",
    keys: ["Mod+Shift+Alt+ArrowRight", "Mod+Shift+Alt+ArrowLeft"],
    helpKeys: ["Ctrl", "⇧", "⌥", "←→"],
    context: "selection",
    coalesce: true,
    paletteHidden: true,
    onKeyDown: (ctx) => {
      const d = arrowDelta(ctx, 1);
      if (d && d.dx !== 0)
        ctx.store.resizeSelectedBy(d.dx, 0, { proportional: true });
    },
  },

  // ---------------- File / export ----------------
  {
    id: "save",
    label: "Save",
    category: "file",
    keys: ["Mod+S"],
    onKeyDown: ({ api }) => api.saveDocument(),
  },
  {
    id: "save-as",
    label: "Save as / export as",
    category: "file",
    keys: ["Mod+Shift+S"],
    onKeyDown: ({ api }) => api.saveDocument(),
  },
  {
    id: "export",
    label: "Export PNG",
    category: "file",
    keys: ["Mod+E"],
    onKeyDown: ({ api }) => api.exportImage(),
  },
  {
    id: "export-options",
    label: "Export options",
    category: "file",
    keys: ["Mod+Shift+E"],
    onKeyDown: ({ api }) => api.exportOptions(),
  },
  {
    id: "copy-image",
    label: "Copy image to clipboard",
    category: "file",
    keys: ["Mod+Shift+C"],
    onKeyDown: ({ api }) => api.copyFlattened(),
  },
];

/** The complete default editor keybind list (tools first, then actions). */
export const EDITOR_KEYBINDS: readonly EditorKeybind[] = [
  ...TOOL_KEYBINDS,
  ...ACTION_KEYBINDS,
];
