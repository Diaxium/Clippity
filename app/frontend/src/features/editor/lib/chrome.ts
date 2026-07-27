/**
 * Window chrome — the macOS / Windows title bar drawn around the capture.
 * Pure geometry + presets, no React, no store.
 *
 * The last slice of Fork F4, and the one part of it that could **not** be built
 * from primitives both renderers already read. Padding and the backdrop
 * (ADR 0020) got their two-renderer parity for free by changing neither
 * renderer; a title bar with traffic lights has no such shortcut, so this
 * module is the shared source of truth instead: every number either renderer
 * needs comes from here, and each one only decides how to *emit* it (SVG
 * elements vs Canvas2D calls). That's the same contract `calloutOutline` and
 * `polygonOutline` already hold, and the reason the branches can't drift.
 *
 * ### Where the bar lives
 *
 * **Above the node's rect, not inside it.** The capture keeps its own box, and
 * the bar occupies `height` px directly above it ({@link chromeBarRect}). Three
 * consequences, all of them the point:
 *
 * - the capture's pixels are never covered or shifted, so chrome is as
 *   non-destructive as crop and padding are;
 * - the node's *outline* — what both renderers use for the drop shadow, the
 *   clip, and strokes — becomes the whole window ({@link chromeWindowRect}), so
 *   a lift shadow lifts the bar with the image instead of casting a seam
 *   between them;
 * - the page has to make room for it, which is why {@link chromeWindowRect} is
 *   what `lib/page.ts` pads around. Without that the page frame's clip would
 *   cut the bar off — the export-region trap of ADR 0019/0020, reached a third
 *   time.
 */

import type {
  ChromeSpec,
  ChromeStyle,
  Corners,
  FrameNode,
  ImageNode,
  Rect,
  RectangleNode,
  SceneNode,
  Vec2,
} from "../types";
import { cornerRadiiOf, hasCornerRadius } from "../types";
import { readableInk } from "./paint";

/** Title-bar height for a fresh chrome, in scene px — close to the real thing
 *  at 1× on both desktops. */
export const DEFAULT_CHROME_HEIGHT = 36;

export const MIN_CHROME_HEIGHT = 16;

/** Bounded for `MAX_PAGE_PADDING`'s reason: a mistyped height must not be able
 *  to produce a page the export then tries to rasterize. */
export const MAX_CHROME_HEIGHT = 200;

/** Corner radius applied to the capture alongside a first chrome, when it has
 *  none. A window with square corners reads as a rendering bug, not a style. */
export const DEFAULT_CHROME_RADIUS = 10;

export function clampChromeHeight(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_CHROME_HEIGHT;
  return Math.round(
    Math.max(MIN_CHROME_HEIGHT, Math.min(MAX_CHROME_HEIGHT, height))
  );
}

// ---------- presets ----------

/**
 * A stock title bar. Style and color travel together because they are one
 * choice to the user ("macOS dark"), not two — and because a macOS bar in a
 * Windows gray is a thing nobody wants to be able to pick by accident.
 */
export interface ChromePreset {
  id: string;
  label: string;
  /** null = no chrome ("None"). */
  style: ChromeStyle | null;
  /** Bar background `#rrggbb`; unused when `style` is null. */
  color: string;
}

export const CHROME_PRESETS: readonly ChromePreset[] = [
  { id: "none", label: "None", style: null, color: "" },
  { id: "macos", label: "macOS", style: "macos", color: "#e8e6e6" },
  { id: "macos-dark", label: "macOS dark", style: "macos", color: "#32302f" },
  { id: "windows", label: "Windows", style: "windows", color: "#f3f3f3" },
  {
    id: "windows-dark",
    label: "Windows dark",
    style: "windows",
    color: "#2b2b2b",
  },
];

export function chromePreset(id: string): ChromePreset | null {
  return CHROME_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * Which preset the capture currently shows, or null for an edited one.
 *
 * Matched on the rendered result (style + color) rather than a stored id, for
 * `matchBackdropPreset`'s reason: the height is editable, so the panel
 * must be able to say "this is still macOS dark, just taller" — and if a future
 * control recolors the bar, the chips honestly stop claiming a preset.
 */
export function matchChromePreset(spec: ChromeSpec | null | undefined): string {
  if (!spec) return "none";
  const hit = CHROME_PRESETS.find(
    (p) =>
      p.style === spec.style &&
      p.color.toLowerCase() === spec.color.toLowerCase()
  );
  return hit ? hit.id : "";
}

/** A fresh spec for a preset. `title` is carried over by the caller rather than
 *  defaulted here — it's content, not style, so switching macOS→Windows must
 *  not wipe what the user typed. */
export function makeChrome(
  preset: ChromePreset,
  title = ""
): ChromeSpec | null {
  if (!preset.style) return null;
  return {
    style: preset.style,
    height: DEFAULT_CHROME_HEIGHT,
    color: preset.color,
    title,
  };
}

// ---------- geometry ----------

/**
 * Whether this node can carry chrome.
 *
 * Keyed on corner radii because that is exactly the set of types whose outline
 * both renderers build from {@link cornerRadiiOf} — frame, rectangle, image.
 * "The capture" is whatever holds the largest image fill (`findBaseImage`), and
 * an ellipse could in principle qualify; a title bar on an ellipse has no
 * meaning and no code path, so the panel hides instead of drawing nonsense.
 * This is the same guard the Corners field already uses (ADR 0020).
 */
export function canCarryChrome(
  node: SceneNode
): node is FrameNode | RectangleNode | ImageNode {
  return hasCornerRadius(node);
}

/** The node's chrome, or null — including for nodes that can't carry it, so a
 *  stale spec on an ellipse is inert rather than half-rendered. */
export function chromeOf(node: SceneNode): ChromeSpec | null {
  const spec = node.chrome;
  if (!spec || !canCarryChrome(node)) return null;
  return spec;
}

/** Bar height in scene px, or 0 when the node has no chrome. The "does this
 *  node have chrome" question in numeric form — callers that only need the
 *  offset don't have to null-check. */
export function chromeHeight(node: SceneNode): number {
  const spec = chromeOf(node);
  return spec ? clampChromeHeight(spec.height) : 0;
}

/** The title bar itself: full node width, sitting directly on top of it. */
export function chromeBarRect(node: SceneNode): Rect | null {
  const h = chromeHeight(node);
  if (h <= 0) return null;
  return { x: node.x, y: node.y - h, width: node.width, height: h };
}

/**
 * The whole window — bar plus capture — which is the node's effective outline
 * once it has chrome, and the rect `lib/page.ts` pads around.
 *
 * Falls back to the node's own rect with no chrome, so callers can use it
 * unconditionally.
 */
export function chromeWindowRect(node: SceneNode): Rect {
  const h = chromeHeight(node);
  return {
    x: node.x,
    y: node.y - h,
    width: node.width,
    height: node.height + h,
  };
}

/**
 * Corner radii for the window outline.
 *
 * The node's own radii, re-applied to the taller rect: `tl`/`tr` land on the
 * *bar's* top and `br`/`bl` on the capture's bottom, which is precisely the
 * window shape. Clamping stays the node's (`cornerRadiiOf` bounds by the
 * shorter side, and the window is only ever taller), so a radius that fits the
 * capture always fits the window.
 */
export function chromeWindowRadii(node: SceneNode): Corners {
  return hasCornerRadius(node)
    ? cornerRadiiOf(node)
    : { tl: 0, tr: 0, br: 0, bl: 0 };
}

// ---------- bar contents ----------

/** Readable ink for a bar background — near-black on light bars, near-white on
 *  dark ones. The luminance rule lives in `lib/paint.ts` because the
 *  measurement label pill needs exactly the same answer for exactly the same
 *  reason (legible text over a user-chosen color). */
export function chromeInk(color: string): string {
  return readableInk(color);
}

/** One macOS traffic light. */
export interface ChromeDot {
  cx: number;
  cy: number;
  r: number;
  color: string;
}

/** macOS traffic-light colors, left to right. */
const MAC_DOTS = ["#ff5f57", "#febc2e", "#28c840"] as const;

/**
 * The macOS traffic lights, or `[]` for any other style.
 *
 * Every measurement scales with the bar height (`k`), so a 72px bar on a 2×
 * capture is the same design at twice the size rather than a normal bar with
 * lost dots in the corner. Dots are dropped entirely when the capture is too
 * narrow to hold them without colliding with the title — better absent than
 * overlapping.
 */
export function chromeDots(node: SceneNode): ChromeDot[] {
  const spec = chromeOf(node);
  const bar = chromeBarRect(node);
  if (!spec || !bar || spec.style !== "macos") return [];
  const k = bar.height / DEFAULT_CHROME_HEIGHT;
  const r = 6 * k;
  const gap = 20 * k;
  const first = bar.x + 20 * k;
  if (bar.width < first - bar.x + gap * 2 + r) return [];
  const cy = bar.y + bar.height / 2;
  return MAC_DOTS.map((color, i) => ({ cx: first + i * gap, cy, r, color }));
}

/** One Windows caption button, as polylines to stroke (a box for maximize is
 *  four segments; close is two). */
export interface ChromeControl {
  /** Polylines in scene space; each is stroked open. */
  strokes: Vec2[][];
  color: string;
  width: number;
}

/**
 * The Windows minimize / maximize / close glyphs, or `[]` for any other style.
 *
 * Drawn as strokes rather than a font so both renderers can emit them from the
 * same points — a glyph font would have made the SVG and the Canvas2D export
 * depend on identical text metrics, which is exactly the parity risk this
 * module exists to avoid.
 */
export function chromeControls(node: SceneNode): ChromeControl[] {
  const spec = chromeOf(node);
  const bar = chromeBarRect(node);
  if (!spec || !bar || spec.style !== "windows") return [];
  const k = bar.height / DEFAULT_CHROME_HEIGHT;
  const slot = 46 * k;
  const g = 5 * k; // glyph half-size
  const width = Math.max(1, 1.2 * k);
  const color = chromeInk(spec.color);
  const cy = bar.y + bar.height / 2;
  const right = bar.x + bar.width;
  // Not enough room for three slots without eating the title: draw none.
  if (bar.width < slot * 3 + 40 * k) return [];
  const cx = (i: number): number => right - slot * (i + 0.5);
  const close = cx(0);
  const max = cx(1);
  const min = cx(2);
  return [
    {
      color,
      width,
      strokes: [
        [
          { x: min - g, y: cy },
          { x: min + g, y: cy },
        ],
      ],
    },
    {
      color,
      width,
      strokes: [
        [
          { x: max - g, y: cy - g },
          { x: max + g, y: cy - g },
          { x: max + g, y: cy + g },
          { x: max - g, y: cy + g },
          { x: max - g, y: cy - g },
        ],
      ],
    },
    {
      color,
      width,
      strokes: [
        [
          { x: close - g, y: cy - g },
          { x: close + g, y: cy + g },
        ],
        [
          { x: close + g, y: cy - g },
          { x: close - g, y: cy + g },
        ],
      ],
    },
  ];
}

/** The bar's title label, or null when there's no text to draw. */
export interface ChromeTitle {
  text: string;
  x: number;
  /** Vertical center of the text (both renderers center on it). */
  y: number;
  size: number;
  weight: number;
  color: string;
  align: "left" | "center";
}

/**
 * Where the title sits: centered on macOS, left-aligned after the app-icon
 * gutter on Windows — the two conventions each desktop actually uses.
 */
export function chromeTitle(node: SceneNode): ChromeTitle | null {
  const spec = chromeOf(node);
  const bar = chromeBarRect(node);
  if (!spec || !bar) return null;
  const text = spec.title.trim();
  if (!text) return null;
  const k = bar.height / DEFAULT_CHROME_HEIGHT;
  const color = chromeInk(spec.color);
  const y = bar.y + bar.height / 2;
  if (spec.style === "macos") {
    return {
      text,
      x: bar.x + bar.width / 2,
      y,
      size: 13 * k,
      weight: 600,
      color,
      align: "center",
    };
  }
  return {
    text,
    x: bar.x + 14 * k,
    y,
    size: 12 * k,
    weight: 400,
    color,
    align: "left",
  };
}

/** The hairline between the bar and the capture, or null with no chrome. Its
 *  ink is the bar's, heavily faded — a separator that reads on a light bar and
 *  a dark one without a second color to keep in sync. */
export function chromeSeparator(node: SceneNode): {
  x1: number;
  x2: number;
  y: number;
  color: string;
  opacity: number;
} | null {
  const spec = chromeOf(node);
  const bar = chromeBarRect(node);
  if (!spec || !bar) return null;
  return {
    x1: bar.x,
    x2: bar.x + bar.width,
    y: node.y,
    color: chromeInk(spec.color),
    opacity: 0.14,
  };
}
