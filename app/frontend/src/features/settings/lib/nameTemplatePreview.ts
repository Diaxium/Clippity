/**
 * Live-preview renderer for the capture file-name template (Settings →
 * General). A deliberately small mirror of Rust `domain::naming::render`
 * — enough to show the user a realistic example filename as they type.
 * The backend remains the source of truth at capture time; this only has
 * to *look* right, so it expands tokens against a fixed sample and applies
 * the same key sanitisation rules (illegal chars, whitespace collapse,
 * leading/trailing dot & space stripping).
 */

import { DEFAULT_NAME_TEMPLATE } from "@services/tauri/clients/settings";

/** Sample capture context the preview renders against. */
const SAMPLE = {
  window: "GitHub - PR #42 - Chrome",
  type: "Region",
  date: "2026-06-13",
  time: "2.34.15 PM",
} as const;

/**
 * Windows-illegal filename characters + ASCII control chars. Mirrors the
 * Rust `is_illegal` set (`< > : " / \ | ? *`); spaces and hyphens are
 * intentionally NOT here (spaces are collapsed, hyphens are legal).
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;
const SEGMENT_MAX = 80;
const STEM_MAX = 150;

function sanitizeSegment(value: string): string {
  return value
    .replace(ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEGMENT_MAX);
}

function stripDotsSpaces(value: string): string {
  return value.replace(/^[.\s]+|[.\s]+$/g, "");
}

/**
 * Render `template` to an example `*.png` file name. A blank template
 * resolves to {@link DEFAULT_NAME_TEMPLATE}; unknown `{tokens}` expand to
 * nothing (never leaking braces); the result never starts with a dot.
 */
export function previewName(template: string): string {
  const tpl = template.trim() || DEFAULT_NAME_TEMPLATE;

  const window = sanitizeSegment(SAMPLE.window);
  const type = sanitizeSegment(SAMPLE.type) || "Capture";
  const values: Record<string, string> = {
    label: window || type,
    window,
    type,
    date: SAMPLE.date,
    time: SAMPLE.time,
  };

  const expanded = tpl.replace(
    /\{(\w+)\}/g,
    (_match, name: string) => values[name] ?? ""
  );

  const collapsed = expanded.replace(/\s+/g, " ");
  const stem = stripDotsSpaces(stripDotsSpaces(collapsed).slice(0, STEM_MAX));
  return `${stem || "Clippity"}.png`;
}
