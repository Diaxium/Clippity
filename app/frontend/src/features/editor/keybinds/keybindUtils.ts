/**
 * Pure helpers for the keybind system: platform detection, typing-surface
 * detection, event/combo → canonical signature, platform-aware display
 * formatting, and conflict detection. No React, no store — every export is a
 * deterministic function the registry, hook, and tests share.
 *
 * Matching is layout-stable: main keys are derived from `KeyboardEvent.code`
 * (so `Shift+1` and `Shift+=` don't mutate into `!`/`+`), with named keys
 * falling back to `KeyboardEvent.key`. Ctrl and Cmd collapse into one `mod`
 * flag so every binding is written once with `Mod`.
 */

import type { EditorKeybind, KeybindContext } from "./keybindTypes";

/** True on macOS — flips `Mod` display to ⌘ and Alt to ⌥. */
export const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(
    // `platform` is the most reliable signal; userAgent is the fallback.
    (navigator.platform || navigator.userAgent || "").toString()
  );

/**
 * Is the event target a typing surface? Tool/editing shortcuts are suppressed
 * here so normal typing never switches tools. Covers native inputs, selects,
 * contenteditable, ARIA textbox/searchbox/spinbutton, and the editor's own
 * inline text editor (a `<textarea>`), plus rename/search/numeric fields.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  const role = el.getAttribute?.("role");
  return role === "textbox" || role === "searchbox" || role === "spinbutton";
}

/** Canonical key signature. Ctrl/Cmd unify into `mod`; `key` is a lowercase,
 *  layout-stable token (e.g. "v", "1", "]", "arrowup", "space", "escape"). */
export interface KeySig {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** `KeyboardEvent.code` fragments → punctuation/named tokens. */
const CODE_TOKEN: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Minus: "-",
  Slash: "/",
  Comma: ",",
  Period: ".",
  Backquote: "`",
  Backslash: "\\",
  Space: "space",
};

/** Layout-stable token for the event's main key. */
export function tokenFromEvent(e: KeyboardEvent): string {
  const code = e.code;
  if (code) {
    if (code.startsWith("Key")) return code.slice(3).toLowerCase(); // KeyV → v
    if (code.startsWith("Digit")) return code.slice(5); // Digit1 → 1
    if (code.startsWith("Numpad")) {
      const rest = code.slice(6);
      if (/^\d$/.test(rest)) return rest; // Numpad1 → 1
    }
    const mapped = CODE_TOKEN[code];
    if (mapped) return mapped;
  }
  const k = e.key;
  if (k === " " || k === "Spacebar") return "space";
  return k.toLowerCase();
}

export function sigFromEvent(e: KeyboardEvent): KeySig {
  return {
    mod: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
    key: tokenFromEvent(e),
  };
}

/** Map an author-written key word to the same token space as the event. */
function normalizeKeyToken(s: string): string {
  switch (s) {
    case "space":
    case "spacebar":
      return "space";
    case "esc":
    case "escape":
      return "escape";
    case "del":
    case "delete":
      return "delete";
    case "backspace":
      return "backspace";
    case "enter":
    case "return":
      return "enter";
    case "tab":
      return "tab";
    case "up":
    case "arrowup":
      return "arrowup";
    case "down":
    case "arrowdown":
      return "arrowdown";
    case "left":
    case "arrowleft":
      return "arrowleft";
    case "right":
    case "arrowright":
      return "arrowright";
    case "plus":
      return "="; // "+" is Shift+"="; author bindings use "=" to stay stable
    case "minus":
      return "-";
    case "slash":
    case "question":
      return "/"; // "?" is Shift+"/"
    default:
      return s; // single letters, digits, punctuation tokens
  }
}

/** Parse an author combo (e.g. "Mod+Shift+]") into a canonical signature. */
export function parseCombo(combo: string): KeySig {
  let mod = false;
  let shift = false;
  let alt = false;
  let key = "";
  for (const raw of combo.split("+")) {
    const part = raw.trim().toLowerCase();
    if (!part) continue;
    if (
      part === "mod" ||
      part === "cmd" ||
      part === "command" ||
      part === "ctrl" ||
      part === "control" ||
      part === "meta"
    ) {
      mod = true;
    } else if (part === "shift") {
      shift = true;
    } else if (part === "alt" || part === "option" || part === "opt") {
      alt = true;
    } else {
      key = normalizeKeyToken(part);
    }
  }
  return { mod, shift, alt, key };
}

/** Stable string key for a signature — the index/lookup primitive. */
export function sigKey(s: KeySig): string {
  return `${s.mod ? "m" : ""}${s.shift ? "s" : ""}${s.alt ? "a" : ""}:${s.key}`;
}

export function comboSigKey(combo: string): string {
  return sigKey(parseCombo(combo));
}

export function eventSigKey(e: KeyboardEvent): string {
  return sigKey(sigFromEvent(e));
}

/** Lone-modifier tokens (from `KeyboardEvent.key`) — never a bindable main
 *  key on their own. */
const MODIFIER_TOKENS = new Set([
  "control",
  "shift",
  "alt",
  "meta",
  "os",
  "super",
  "hyper",
  "capslock",
  "fn",
]);

/**
 * Author-combo string captured from a live keyboard event — the primitive
 * the Shortcuts settings recorder builds a new binding from. Returns null
 * while only modifiers are held (nothing to bind yet). Uses the same
 * layout-stable token space as {@link parseCombo}, so the result round-trips
 * through {@link comboSigKey} and displays through {@link formatCombo}.
 *
 * Order matches `formatCombo`: `Mod` · `Shift` · `Alt` · key. Ctrl and Cmd
 * both collapse to `Mod`.
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const token = tokenFromEvent(e);
  if (!token || MODIFIER_TOKENS.has(token)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Mod");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(token);
  return parts.join("+");
}

/** Pretty token → chip label. */
const KEY_LABELS: Record<string, string> = {
  space: "Space",
  escape: "Esc",
  enter: "Enter",
  delete: "Del",
  backspace: "⌫",
  tab: "Tab",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

/** Platform-aware chip labels for a combo, e.g. `["⌘","⇧","]"]` on macOS or
 *  `["Ctrl","Shift","]"]` elsewhere. Order: Mod · Shift · Alt · key. */
export function formatCombo(combo: string): string[] {
  const s = parseCombo(combo);
  const out: string[] = [];
  if (s.mod) out.push(IS_MAC ? "⌘" : "Ctrl");
  if (s.shift) out.push(IS_MAC ? "⇧" : "Shift");
  if (s.alt) out.push(IS_MAC ? "⌥" : "Alt");
  if (s.key) out.push(KEY_LABELS[s.key] ?? s.key.toUpperCase());
  return out;
}

export interface KeybindConflict {
  context: KeybindContext;
  sig: string;
  ids: string[];
}

/**
 * Find duplicate bindings: two non-hidden keybinds in the *same* context that
 * resolve to the same signature (a true ambiguity). Different contexts may share
 * a key on purpose — dispatch layers them by priority — so those aren't flagged.
 */
export function findKeybindConflicts(
  keybinds: readonly EditorKeybind[]
): KeybindConflict[] {
  const seen = new Map<string, string[]>();
  for (const kb of keybinds) {
    if (kb.hidden) continue;
    const context = kb.context ?? "editor";
    for (const combo of kb.keys) {
      const bucket = `${context}|${comboSigKey(combo)}`;
      const ids = seen.get(bucket);
      if (ids) ids.push(kb.id);
      else seen.set(bucket, [kb.id]);
    }
  }
  const conflicts: KeybindConflict[] = [];
  for (const [bucket, ids] of seen) {
    if (ids.length > 1) {
      const sep = bucket.indexOf("|");
      conflicts.push({
        context: bucket.slice(0, sep) as KeybindContext,
        sig: bucket.slice(sep + 1),
        ids,
      });
    }
  }
  return conflicts;
}
