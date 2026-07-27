/**
 * Editor scene model — a Figma-style scene graph. Pure data, no React.
 *
 * Geometry lives in scene space (CSS px at zoom 1). Every node carries an
 * axis-aligned local frame `{ x, y, width, height }` plus a `rotation`
 * (degrees, clockwise about the frame's center). Box nodes keep positive
 * `width`/`height` and may rotate; line-like nodes keep `rotation === 0`
 * and encode direction in signed `width`/`height` (the segment runs from
 * `(x, y)` to `(x + width, y + height)`). `nodeBounds` normalizes both into
 * a positive AABB for hit-testing, the layer tree, and the design panel.
 *
 * Nodes are stored flat in the store (`Record<id, SceneNode>`); a frame's
 * `children` and the scene's `rootIds` hold ids in back-to-front paint order
 * (index 0 paints first / sits at the back). The layer tree renders that
 * order top-to-bottom, matching the reference design where the background
 * image sits at the top of the list.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ToolId =
  | "select"
  | "crop"
  | "frame"
  | "rectangle"
  | "ellipse"
  | "line"
  | "arrow"
  | "blur"
  | "pixelate"
  | "magnify"
  | "highlight"
  | "step"
  | "callout"
  | "spotlight"
  | "measure"
  | "stamp"
  | "polygon"
  | "star"
  | "text"
  | "image"
  | "hand"
  | "pen"
  | "pencil"
  | "comment";

/** Editor tool modes (Workstream M). A mode filters which tools/panels are
 *  available; it never changes the scene graph. */
export type EditorMode = "annotate" | "design";

/** The inspector's three families of properties — how the selection looks,
 *  where it sits, and a read-only readout of both. Orthogonal to
 *  {@link EditorMode}: a mode decides which sections exist, a tab decides which
 *  of them are on screen. */
export type InspectorTab = "style" | "arrange" | "inspect";

/** Which mode(s) each tool appears in. Shared primitives are in both; Annotation
 *  owns the markup tools, Design owns the vector-design tools. */
const TOOL_MODES: Record<ToolId, readonly EditorMode[]> = {
  select: ["annotate", "design"],
  hand: ["annotate", "design"],
  // Crop resizes the page itself, so it's a document operation both modes need.
  crop: ["annotate", "design"],
  text: ["annotate", "design"],
  arrow: ["annotate", "design"],
  line: ["annotate", "design"],
  rectangle: ["annotate", "design"],
  ellipse: ["annotate", "design"],
  blur: ["annotate"],
  pixelate: ["annotate"],
  magnify: ["annotate"],
  highlight: ["annotate"],
  step: ["annotate"],
  callout: ["annotate"],
  spotlight: ["annotate"],
  measure: ["annotate"],
  stamp: ["annotate"],
  frame: ["design"],
  polygon: ["design"],
  star: ["design"],
  image: ["design"],
  pen: ["design"],
  pencil: ["design"],
  comment: [],
};

export function toolInMode(id: ToolId, mode: EditorMode): boolean {
  return TOOL_MODES[id].includes(mode);
}

/** Paint applied as a fill. `solid` uses `color`; `gradient` uses `gradient`;
 *  `image` paints `src` scaled to cover the frame. `opacity` multiplies all. */
export type PaintType = "solid" | "gradient" | "image";

export type GradientKind = "linear" | "radial" | "freeform" | "mesh";

/** Radial profile: box-fit `ellipse` (the default — fills a non-square shape) or
 *  a true `circle`. The two renderers must agree on this (see Workstream G1). */
export type GradientShape = "circle" | "ellipse";

/** Image-fill sizing: `fill` (cover), `fit` (contain), or `stretch` (distort to
 *  the box). Default `fill`. */
export type ImageScale = "fill" | "fit" | "stretch";

/** Image-fill anchor when the image doesn't exactly match the box (fill/fit).
 *  Default `center`. */
export type ImageAlign =
  | "center"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface GradientStop {
  id: string;
  /** Position along the gradient, 0..1. */
  position: number;
  /** `#rrggbb`. */
  color: string;
  /** 0..1. */
  opacity: number;
}

/** A freeform-gradient color point: a localized color source placed at `point`
 *  (normalized 0..1 in the node box) that blends with nearby points. No native
 *  primitive renders this — it's rasterized (IDW blend) by both renderers via
 *  `lib/freeform.ts`. See Workstream G3. */
export interface FreeformStop {
  id: string;
  point: Vec2;
  /** `#rrggbb`. */
  color: string;
  /** 0..1. */
  opacity: number;
}

/** A freeform "line": colors blend along an editable polyline of stops (≥2). The
 *  line is sampled into the same IDW sources as points (`lib/freeform.ts`). */
export interface FreeformLine {
  id: string;
  stops: FreeformStop[];
}

/** Freeform sub-mode: localized color **points** or color **lines**. */
export type FreeformMode = "points" | "lines";

/** One color cell of a mesh gradient (uniform `rows`×`cols` grid, row-major). */
export interface MeshPoint {
  /** `#rrggbb`. */
  color: string;
  /** 0..1. */
  opacity: number;
  /** Normalized (0..1 in the node box) lattice position. Optional for
   *  back-compat — absent means this index's slot on the uniform grid. Dragged
   *  on-canvas to warp the mesh (Workstream G4b). */
  point?: Vec2;
}

/** A mesh gradient: a `rows`×`cols` grid of colored control points, bilinearly
 *  interpolated. No native primitive renders this — it's rasterized like
 *  freeform (ADR 0013/0014). Points carry positions (default: a uniform grid)
 *  that can be dragged to warp the gradient; bicubic smoothness is deferred. */
export interface MeshSpec {
  rows: number;
  cols: number;
  /** `rows * cols` cells, row-major (row 0 top, col 0 left). */
  points: MeshPoint[];
}

/** Uniform lattice position for grid slot (row `j`, col `i`) of a `rows`×`cols`
 *  mesh — evenly spread across the box, centered when an axis has one line. */
export function meshSlotPoint(
  rows: number,
  cols: number,
  j: number,
  i: number
): Vec2 {
  return {
    x: cols <= 1 ? 0.5 : i / (cols - 1),
    y: rows <= 1 ? 0.5 : j / (rows - 1),
  };
}

export interface GradientPaint {
  kind: GradientKind;
  /** Degrees clockwise from the +x axis (linear; the fallback when `start`/`end`
   *  are absent). */
  angle: number;
  stops: GradientStop[];
  /** Optional normalized (0..1 in the node box) geometry handles. All optional
   *  for back-compat — absent fields fall back to `angle` (linear) / centered
   *  ellipse (radial). Resolved by `gradientGeometry`; edited via the on-canvas
   *  handles (Workstream G2). */
  start?: Vec2; // linear gradient start
  end?: Vec2; // linear gradient end
  center?: Vec2; // radial center
  /** Radial radius as a box fraction (0.5 ≈ reaches the box edges). */
  radius?: number;
  focal?: Vec2; // radial focal point (defaults to the center)
  shape?: GradientShape; // radial profile
  /** Color points for a `freeform` gradient in `points` sub-mode. */
  points?: FreeformStop[];
  /** Color lines for a `freeform` gradient in `lines` sub-mode. */
  lines?: FreeformLine[];
  /** Active freeform sub-mode (which array renders + is edited); default points. */
  freeformMode?: FreeformMode;
  /** Grid for a `mesh` gradient (ignored otherwise). */
  mesh?: MeshSpec;
}

export interface Paint {
  id: string;
  type: PaintType;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  /** `#rrggbb`. Used by solid paints; a placeholder tint otherwise. */
  color: string;
  /** Data URI — present on image paints. */
  src?: string;
  /** Present on gradient paints. */
  gradient?: GradientPaint;
  /** Per-fill compositing blend with what's below it; absent = normal. */
  blendMode?: BlendMode;
  /** Image-fill sizing + anchor (image paints; default fill/center = cover). */
  imageScale?: ImageScale;
  imageAlign?: ImageAlign;
}

export type StrokeAlign = "inside" | "center" | "outside";

export interface Stroke {
  id: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  color: string;
  /** px */
  width: number;
  align: StrokeAlign;
}

export type EffectType = "drop-shadow" | "inner-shadow" | "layer-blur";

export interface Effect {
  id: string;
  type: EffectType;
  visible: boolean;
  /** Shadow color (ignored by `layer-blur`). */
  color: string;
  /** 0..1 — shadow alpha. */
  opacity: number;
  offsetX: number;
  offsetY: number;
  /** Blur radius (px). Doubles as the layer-blur amount. */
  blur: number;
  /** Shadow spread (px); unused by blur. */
  spread: number;
}

export type NodeType =
  | "frame"
  | "rectangle"
  | "ellipse"
  | "image"
  | "text"
  | "line"
  | "arrow"
  | "polygon"
  | "star"
  | "path";

/** A "sample" region re-displays the capture's base image, transformed — backs
 *  the Blur and Magnifier annotation tools. The region is an ordinary box
 *  (rectangle/ellipse); only the renderers special-case `sample`. */
export type SampleMode = "blur" | "pixelate" | "magnify";

export interface SampleSpec {
  mode: SampleMode;
  /** blur radius (px) · pixelate cell (px) · magnify zoom (×), by mode. */
  amount: number;
  /** Whether the sample renders. Absent = visible; `false` hides it — backs the
   *  per-effect eye toggle that surfaces the sample in Design mode's Effects
   *  panel (see ADR 0015). */
  enabled?: boolean;
}

/** Default `amount` per sample mode — the seed for a freshly-drawn region and the
 *  reset value when the mode is switched in the Effects panel. */
export const SAMPLE_DEFAULT_AMOUNT: Record<SampleMode, number> = {
  blur: 8,
  pixelate: 12,
  magnify: 2,
};

/** A numbered step badge (Snagit-style). The badge is an ordinary ellipse; only
 *  the renderers special-case `step` to draw the number centered on it. New
 *  badges auto-increment — `editorStore.addNode` assigns the next value. */
export interface StepSpec {
  number: number;
}

/** A speech-bubble callout. The body is an ordinary rectangle; the renderers
 *  splice a pointer **tail** into its outline (one integrated path, so fill and
 *  stroke flow around the tail). The tail aims out from the body center at
 *  `angle` (degrees, 0 = up, clockwise) and its tip extends `length` px past the
 *  body edge — see `calloutOutline`. Both are editable from the panel or by
 *  dragging the tip handle on the canvas (`calloutTailFromLocal`). */
export interface CalloutSpec {
  angle: number;
  length: number;
}

/**
 * A spotlight: a region kept clear while the rest of the page is dimmed, to
 * draw the eye to it (Snagit's "spotlight & magnify", minus the zoom). The
 * region is an ordinary box shape (rectangle/ellipse); only the renderers
 * special-case `spotlight` to paint a **page-covering scrim with the node's
 * shape punched out** — the one annotation whose effect reaches past its own
 * frame, so like window chrome it has no existing primitive and is built from a
 * shared geometry module (`lib/spotlight.ts`) that hands both renderers one
 * even-odd path to fill.
 *
 * The scrim covers the *page frame's* rect, so applying a spotlight seals the
 * page (absorbs stray roots) exactly as crop/backdrop/chrome do — otherwise a
 * stray outside the page would export as an undimmed band (the ADR 0019/0020
 * export-region trap). See ADR 0023.
 */
export interface SpotlightSpec {
  /** Scrim color `#rrggbb` — near-black dims a light capture, near-white a dark
   *  one. */
  color: string;
  /** Scrim opacity 0..1: how strongly everything outside the region is dimmed. */
  opacity: number;
}

/** Scrim seed for a freshly-drawn spotlight — a near-black dim at 60%, which
 *  reads on the light screenshots that make up most captures. `lib/spotlight.ts`
 *  offers a light variant for dark ones. */
export const DEFAULT_SPOTLIGHT_COLOR = "#0b0e14";
export const DEFAULT_SPOTLIGHT_OPACITY = 0.6;

/** How a dimension line terminates: drafting serif **ticks** perpendicular to
 *  the shaft, or **arrow**heads pointing out at each end. */
export type MeasureCap = "tick" | "arrow";

/**
 * A measurement / dimension line (Fork A-F3). The mark is an ordinary **line**
 * node, so its two endpoints — and therefore the measured distance — are the
 * line's own endpoints, editable with the endpoint handles, the marquee, and
 * nudge that every line already has. Only the renderers special-case `measure`,
 * replacing the plain shaft with **caps + a length label** computed by the
 * shared `lib/measure.ts` (the ADR 0022 pattern: one geometry module, one
 * branch per renderer).
 *
 * The measurement itself is derived, never stored: scene space is capture px,
 * so the distance *is* the geometry. Storing it would let the number drift from
 * the line the moment either endpoint moved.
 */
export interface MeasureSpec {
  caps: MeasureCap;
  /**
   * Multiplier from scene px to the displayed number. 1 reads the capture's own
   * pixels; 0.5 reads a 2× (HiDPI) capture in logical px; any factor pairs with
   * `unit` to read a known reference length in real-world units.
   */
  scale: number;
  /** Suffix after the number ("px", "pt", …); empty draws the bare number. */
  unit: string;
}

/** Seeds for a freshly-drawn dimension line — capture pixels, 1:1, with the
 *  drafting tick caps. Kept beside the tool's stroke seed in `defaultStrokes`. */
export const DEFAULT_MEASURE_CAPS: MeasureCap = "tick";
export const DEFAULT_MEASURE_UNIT = "px";

/** The bundled icon a stamp draws. The drawings themselves live in
 *  `lib/stamps.ts`; the union is here so `StampSpec` stays self-contained with
 *  the rest of the scene model. */
export type StampKind =
  | "check"
  | "cross"
  | "warning"
  | "info"
  | "question"
  | "star"
  | "heart"
  | "flag"
  | "pin"
  | "lock"
  | "cursor"
  | "idea";

/**
 * A stamp (Fork A-F4) — one of a bundled set of icon marks. The carrier is an
 * ordinary **rectangle**, whose box the glyph is fit into; only the renderers
 * special-case `stamp`, replacing the box's own shape with the two path strings
 * `lib/stamps.ts` computes (the ADR 0022 pattern, in the ADR 0023 form that
 * shares the *path* rather than the numbers).
 *
 * The spec holds only *which* icon: the color is the node's `fills`, the halo
 * its `strokes`, and the size its frame — all existing controls, so a stamp
 * needs no panel beyond the picker.
 */
export interface StampSpec {
  kind: StampKind;
}

/** Seed for a freshly-drawn stamp, and the picker's initial selection. A check
 *  is the mark a screenshot most often wants. */
export const DEFAULT_STAMP_KIND: StampKind = "check";

/** Which desktop's title bar the chrome imitates. */
export type ChromeStyle = "macos" | "windows";

/**
 * Window chrome drawn around the capture — a macOS or Windows title bar with
 * its buttons. The last slice of Fork F4 and the one part of it with **no
 * existing primitive**: both renderers carry a branch for it, the way `step`
 * and `callout` already do.
 *
 * The bar sits *above* the node's rect rather than inside it (see
 * `lib/chrome.ts`), so the capture's own pixels are never covered or moved and
 * the treatment stays non-destructive. `lib/page.ts` measures padding against
 * the bar-inclusive rect, which is what keeps the page from clipping it.
 */
export interface ChromeSpec {
  style: ChromeStyle;
  /** Title-bar height in scene px. */
  height: number;
  /** Bar background `#rrggbb`; the ink is derived from its luminance. */
  color: string;
  /** Title text; empty draws no label. */
  title: string;
}

/** Separable blend modes — the same string is valid for both CSS
 *  `mix-blend-mode` (SVG) and Canvas2D `globalCompositeOperation`. See ADR 0011. */
export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion";

interface NodeBase {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Local frame in scene space (px). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise, about the frame center. Always 0 for line-like nodes. */
  rotation: number;
  /** 0..1 — multiplies the whole node + its children. */
  opacity: number;
  /** When true, resize keeps the node's width:height ratio without holding Shift. */
  lockAspect: boolean;
  /** Mirror the node (and its children) about its center on each axis. */
  flipH: boolean;
  flipV: boolean;
  fills: Paint[];
  strokes: Stroke[];
  effects: Effect[];
  /** Set on Blur/Magnifier regions — see {@link SampleSpec}. */
  sample?: SampleSpec | null;
  /** Compositing blend with the backdrop; absent = normal. Used by Highlighter. */
  blendMode?: BlendMode;
  /** Set on numbered step badges — see {@link StepSpec}. The renderers draw the
   *  number centered on the node; `addNode` assigns the next sequential value. */
  step?: StepSpec | null;
  /** Set on speech-bubble callouts — see {@link CalloutSpec}. The renderers
   *  replace the box outline with a bubble + pointer tail. */
  callout?: CalloutSpec | null;
  /** Set on a spotlight region — see {@link SpotlightSpec}. The renderers dim
   *  the whole page and punch this node's shape out of the scrim. */
  spotlight?: SpotlightSpec | null;
  /** Set on a dimension line — see {@link MeasureSpec}. The renderers replace
   *  the plain shaft with end caps and a label reading the line's length. */
  measure?: MeasureSpec | null;
  /** Set on an icon stamp — see {@link StampSpec}. The renderers replace the
   *  box's own shape with the glyph fit into it. */
  stamp?: StampSpec | null;
  /** Set on the capture to frame it in a window title bar — see
   *  {@link ChromeSpec}. The renderers grow the node's outline upward by the
   *  bar and draw the bar into it. */
  chrome?: ChromeSpec | null;
}

/** Per-corner radii (px), clockwise from top-left. `null` on a node means the
 *  uniform `cornerRadius` applies to all four. */
export interface Corners {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

export interface FrameNode extends NodeBase {
  type: "frame";
  cornerRadius: number;
  cornerRadii: Corners | null;
  clipContent: boolean;
  /** Child ids in back-to-front order. */
  children: string[];
}

export interface RectangleNode extends NodeBase {
  type: "rectangle";
  cornerRadius: number;
  cornerRadii: Corners | null;
}

export interface EllipseNode extends NodeBase {
  type: "ellipse";
}

export interface PolygonNode extends NodeBase {
  type: "polygon";
  /** Number of sides; 3 = triangle. */
  sides: number;
}

export interface StarNode extends NodeBase {
  type: "star";
  /** Number of outer points. */
  pointCount: number;
  /** Inner-radius ratio (0..1) controlling the spikiness. */
  innerRatio: number;
}

export interface ImageNode extends NodeBase {
  type: "image";
  cornerRadius: number;
  cornerRadii: Corners | null;
}

export type TextAlign = "left" | "center" | "right";

export interface TextNode extends NodeBase {
  type: "text";
  text: string;
  fontSize: number;
  fontWeight: number;
  /** Multiplier of `fontSize`. */
  lineHeight: number;
  /** px */
  letterSpacing: number;
  align: TextAlign;
  color: string;
}

export interface LineNode extends NodeBase {
  type: "line";
}

export interface ArrowNode extends NodeBase {
  type: "arrow";
}

export interface PathNode extends NodeBase {
  type: "path";
  /** Vertices in normalized 0..1 box coordinates (so the box transform scales
   *  the path for free). */
  points: Vec2[];
  /** Closed paths join the last point back to the first and can be filled. */
  closed: boolean;
}

export type SceneNode =
  | FrameNode
  | RectangleNode
  | EllipseNode
  | ImageNode
  | TextNode
  | LineNode
  | ArrowNode
  | PolygonNode
  | StarNode
  | PathNode;

export type ContainerNode = FrameNode;

/** Document = ordered top-level node ids + a flat id→node map. The unit of
 *  undo/redo. */
export interface SceneDoc {
  /** Top-level node ids in back-to-front paint order (index 0 = back). */
  rootIds: string[];
  nodes: Record<string, SceneNode>;
}

// ---------- Type guards ----------

const RADIUS_TYPES: Record<NodeType, boolean> = {
  frame: true,
  rectangle: true,
  image: true,
  ellipse: false,
  text: false,
  line: false,
  arrow: false,
  polygon: false,
  star: false,
  path: false,
};

export function hasCornerRadius(
  node: SceneNode
): node is FrameNode | RectangleNode | ImageNode {
  return RADIUS_TYPES[node.type];
}

/** Effective per-corner radii, clamped so adjacent corners can't overlap. Falls
 *  back to the uniform `cornerRadius` when `cornerRadii` is null. */
export function cornerRadiiOf(
  node: FrameNode | RectangleNode | ImageNode
): Corners {
  const maxR = Math.min(node.width, node.height) / 2;
  const clamp = (n: number): number => Math.max(0, Math.min(n, maxR));
  const c = node.cornerRadii ?? {
    tl: node.cornerRadius,
    tr: node.cornerRadius,
    br: node.cornerRadius,
    bl: node.cornerRadius,
  };
  return { tl: clamp(c.tl), tr: clamp(c.tr), br: clamp(c.br), bl: clamp(c.bl) };
}

export function isContainer(node: SceneNode): node is FrameNode {
  return node.type === "frame";
}

export function isLineLike(node: SceneNode): node is LineNode | ArrowNode {
  return node.type === "line" || node.type === "arrow";
}

/** Box nodes use the 8-handle transform; line-like nodes use endpoints. */
export function isBoxLike(
  node: SceneNode
): node is
  | FrameNode
  | RectangleNode
  | EllipseNode
  | ImageNode
  | TextNode
  | PolygonNode
  | StarNode
  | PathNode {
  return !isLineLike(node);
}

/** Node types whose renderers paint a `sample` (blur/pixelate/magnify) — every
 *  area shape. Frames (containers), text, and line-like nodes have no fillable
 *  area to obscure, so the Effects panel doesn't offer a sample for them. Kept in
 *  sync with the renderers' sample branches (see ADR 0015). */
const SAMPLEABLE_TYPES: Record<NodeType, boolean> = {
  rectangle: true,
  ellipse: true,
  image: true,
  polygon: true,
  star: true,
  path: true,
  frame: false,
  text: false,
  line: false,
  arrow: false,
};

export function canCarrySample(node: SceneNode): boolean {
  return SAMPLEABLE_TYPES[node.type];
}

// ---------- Geometry helpers (frame ↔ bounds) ----------

/** Positive AABB for a node, ignoring rotation. For line-like nodes this is
 *  the segment's enclosing box; for box nodes it is the unrotated frame. */
export function nodeBounds(node: SceneNode): Rect {
  if (isLineLike(node)) {
    const x = Math.min(node.x, node.x + node.width);
    const y = Math.min(node.y, node.y + node.height);
    return {
      x,
      y,
      width: Math.abs(node.width),
      height: Math.abs(node.height),
    };
  }
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

/** Endpoints of a line-like node in scene space. */
export function lineEndpoints(node: LineNode | ArrowNode): {
  a: Vec2;
  b: Vec2;
} {
  return {
    a: { x: node.x, y: node.y },
    b: { x: node.x + node.width, y: node.y + node.height },
  };
}

// ---------- Style seeds ----------

export const EDITOR_INK = "#e6e6e6";
const ACCENT_RED = "#f24822";
const HIGHLIGHT_INK = "#ffe24d";

/** Per-tool default paints. Solid shapes start with a translucent fill +
 *  a crisp outline; lines/arrows ship outline-only. */
export function defaultFills(tool: ToolId): Paint[] {
  switch (tool) {
    case "highlight":
      // Translucent-by-multiply marker color (the node blends multiply).
      return [makeSolidPaint(HIGHLIGHT_INK, 1)];
    case "step":
      // Filled accent badge; the renderers draw the white number on top.
      return [makeSolidPaint(ACCENT_RED, 1)];
    case "callout":
      // Light bubble body so captions read against it; accent border (below).
      return [makeSolidPaint("#ffffff", 1)];
    case "stamp":
      // The glyph's ink — a stamp's fills paint the icon, not a box behind it.
      return [makeSolidPaint(ACCENT_RED, 1)];
    case "rectangle":
    case "ellipse":
    case "frame":
    case "polygon":
    case "star":
      return [makeSolidPaint("#9747ff", 1)];
    case "text":
    case "line":
    case "arrow":
    case "image":
    case "select":
    case "crop":
    case "hand":
    case "pen":
    case "pencil":
    case "comment":
    case "blur":
    case "pixelate":
    case "magnify":
    case "spotlight":
    case "measure":
      // Sample + spotlight regions show the underlying image, not a fill; a
      // dimension line is a stroke and a label, with no area to fill.
      return [];
  }
}

export function defaultStrokes(tool: ToolId): Stroke[] {
  switch (tool) {
    case "line":
    case "arrow":
    case "pen":
    case "pencil":
      return [makeStroke(ACCENT_RED, 3)];
    case "magnify":
      // Loupe ring around the magnified region.
      return [makeStroke("#ffffff", 3, "center")];
    case "callout":
      // Accent border that flows around the body + tail outline.
      return [makeStroke(ACCENT_RED, 2)];
    case "measure":
      // The dimension's whole appearance — shaft, caps, and the label pill —
      // is drawn from this one stroke, so recoloring the mark is one control.
      return [makeStroke(ACCENT_RED, 2)];
    case "stamp":
      // A stamp's stroke is a *halo* under the glyph (see lib/stamps.ts), and
      // white is what makes a mark read on a busy screenshot. Align is `center`
      // because a glyph has no single inside for the other two to mean.
      return [makeStroke("#ffffff", 2, "center")];
    case "rectangle":
    case "ellipse":
    case "frame":
    case "polygon":
    case "star":
    case "text":
    case "image":
    case "select":
    case "crop":
    case "hand":
    case "comment":
    case "blur":
    case "pixelate":
    case "highlight":
    case "step":
    case "spotlight":
      return [];
  }
}

// ---------- Factories ----------

let _counter = 0;

export function nextNodeId(prefix = "n"): string {
  _counter += 1;
  return `${prefix}_${_counter.toString(36)}`;
}

/** Test-only: reset the id counter so deterministic snapshots line up. */
export function __resetNodeIdForTests(): void {
  _counter = 0;
}

/**
 * Advance the global id counter past every id already in a loaded scene, so
 * nodes/paints created after a restore can't collide with restored ones. Ids
 * are `<prefix>_<base36>` drawing from one counter; this scans nodes plus their
 * fills/strokes/effects/gradient stops and bumps the counter to the maximum.
 */
export function reseedNodeIds(nodes: Record<string, SceneNode>): void {
  let max = _counter;
  const consider = (id: string | undefined): void => {
    if (!id) return;
    const us = id.lastIndexOf("_");
    if (us < 0) return;
    const n = parseInt(id.slice(us + 1), 36);
    if (Number.isFinite(n) && n > max) max = n;
  };
  for (const nodeId of Object.keys(nodes)) {
    consider(nodeId);
    const node = nodes[nodeId];
    if (!node) continue;
    for (const f of node.fills) {
      consider(f.id);
      const g = f.gradient;
      if (g) {
        g.stops?.forEach((s) => consider(s.id));
        g.points?.forEach((p) => consider(p.id));
        g.lines?.forEach((l) => {
          consider(l.id);
          l.stops.forEach((s) => consider(s.id));
        });
      }
    }
    for (const s of node.strokes) consider(s.id);
    for (const e of node.effects) consider(e.id);
  }
  _counter = max;
}

export function makeSolidPaint(color: string, opacity = 1): Paint {
  return {
    id: nextNodeId("fill"),
    type: "solid",
    visible: true,
    opacity,
    color,
  };
}

export function makeGradientPaint(from = "#9747FF", to = "#0D99FF"): Paint {
  return {
    id: nextNodeId("fill"),
    type: "gradient",
    visible: true,
    opacity: 1,
    color: from,
    gradient: {
      kind: "linear",
      angle: 90,
      stops: [
        { id: nextNodeId("stop"), position: 0, color: from, opacity: 1 },
        { id: nextNodeId("stop"), position: 1, color: to, opacity: 1 },
      ],
    },
  };
}

/** Default color points for a fresh freeform gradient — three sources spread
 *  across the box so the blend reads immediately. */
export function makeFreeformPoints(): FreeformStop[] {
  return [
    {
      id: nextNodeId("pt"),
      point: { x: 0.25, y: 0.28 },
      color: "#9747ff",
      opacity: 1,
    },
    {
      id: nextNodeId("pt"),
      point: { x: 0.78, y: 0.24 },
      color: "#0d99ff",
      opacity: 1,
    },
    {
      id: nextNodeId("pt"),
      point: { x: 0.5, y: 0.8 },
      color: "#ff5c93",
      opacity: 1,
    },
  ];
}

/** A default mesh gradient — a 2×2 grid of corner colors (a smooth four-corner
 *  blend), expandable via {@link resizeMesh}. */
export function makeMesh(): MeshSpec {
  const colors = ["#9747ff", "#0d99ff", "#ff5c93", "#ffd166"]; // TL, TR, BL, BR
  const points: MeshPoint[] = [];
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      points.push({
        color: colors[j * 2 + i]!,
        opacity: 1,
        point: meshSlotPoint(2, 2, j, i),
      });
    }
  }
  return { rows: 2, cols: 2, points };
}

/** Resize a mesh to `rows`×`cols` (clamped 1..8), keeping overlapping cells and
 *  extending new rows/cols from the nearest existing edge color. */
export function resizeMesh(
  mesh: MeshSpec,
  rows: number,
  cols: number
): MeshSpec {
  const r = Math.max(1, Math.min(8, Math.round(rows)));
  const c = Math.max(1, Math.min(8, Math.round(cols)));
  const nearest = (j: number, i: number): MeshPoint =>
    mesh.points[
      Math.min(mesh.rows - 1, j) * mesh.cols + Math.min(mesh.cols - 1, i)
    ]!;
  const points: MeshPoint[] = [];
  for (let j = 0; j < r; j++) {
    for (let i = 0; i < c; i++) {
      const src =
        j < mesh.rows && i < mesh.cols
          ? mesh.points[j * mesh.cols + i]!
          : nearest(j, i);
      // Topology changed, so reset to the uniform grid for the new dimensions.
      points.push({
        color: src.color,
        opacity: src.opacity,
        point: meshSlotPoint(r, c, j, i),
      });
    }
  }
  return { rows: r, cols: c, points };
}

/** A default freeform line — three stops flowing across the box. */
export function makeFreeformLine(): FreeformLine {
  return {
    id: nextNodeId("ln"),
    stops: [
      {
        id: nextNodeId("pt"),
        point: { x: 0.2, y: 0.3 },
        color: "#9747ff",
        opacity: 1,
      },
      {
        id: nextNodeId("pt"),
        point: { x: 0.5, y: 0.55 },
        color: "#0d99ff",
        opacity: 1,
      },
      {
        id: nextNodeId("pt"),
        point: { x: 0.8, y: 0.78 },
        color: "#ff5c93",
        opacity: 1,
      },
    ],
  };
}

export function makeImagePaint(src: string): Paint {
  return {
    id: nextNodeId("fill"),
    type: "image",
    visible: true,
    opacity: 1,
    color: "#000000",
    src,
  };
}

export function makeStroke(
  color: string,
  width = 1,
  align: StrokeAlign = "inside"
): Stroke {
  return {
    id: nextNodeId("stroke"),
    visible: true,
    opacity: 1,
    color,
    width,
    align,
  };
}

export function makeShadow(): Effect {
  return {
    id: nextNodeId("fx"),
    type: "drop-shadow",
    visible: true,
    color: "#000000",
    opacity: 0.25,
    offsetX: 0,
    offsetY: 4,
    blur: 12,
    spread: 0,
  };
}

interface BaseInit {
  name?: string;
  fills?: Paint[];
  strokes?: Stroke[];
  effects?: Effect[];
  rotation?: number;
  opacity?: number;
}

function baseNode(rect: Rect, init: BaseInit): NodeBase {
  return {
    id: nextNodeId(),
    name: init.name ?? "Layer",
    visible: true,
    locked: false,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    rotation: init.rotation ?? 0,
    opacity: init.opacity ?? 1,
    lockAspect: false,
    flipH: false,
    flipV: false,
    fills: init.fills ?? [],
    strokes: init.strokes ?? [],
    effects: init.effects ?? [],
  };
}

export function makeFrame(
  rect: Rect,
  init: BaseInit & { cornerRadius?: number; clipContent?: boolean } = {}
): FrameNode {
  return {
    ...baseNode(rect, { name: "Frame", ...init }),
    type: "frame",
    cornerRadius: init.cornerRadius ?? 0,
    cornerRadii: null,
    clipContent: init.clipContent ?? true,
    children: [],
  };
}

export function makeRectangle(
  rect: Rect,
  init: BaseInit & { cornerRadius?: number } = {}
): RectangleNode {
  return {
    ...baseNode(rect, {
      name: "Rectangle",
      fills: defaultFills("rectangle"),
      ...init,
    }),
    type: "rectangle",
    cornerRadius: init.cornerRadius ?? 0,
    cornerRadii: null,
  };
}

export function makeEllipse(rect: Rect, init: BaseInit = {}): EllipseNode {
  return {
    ...baseNode(rect, {
      name: "Ellipse",
      fills: defaultFills("ellipse"),
      ...init,
    }),
    type: "ellipse",
  };
}

export function makePolygon(
  rect: Rect,
  init: BaseInit & { sides?: number } = {}
): PolygonNode {
  return {
    ...baseNode(rect, {
      name: "Polygon",
      fills: defaultFills("polygon"),
      ...init,
    }),
    type: "polygon",
    sides: init.sides ?? 3,
  };
}

export function makeStar(
  rect: Rect,
  init: BaseInit & { pointCount?: number; innerRatio?: number } = {}
): StarNode {
  return {
    ...baseNode(rect, { name: "Star", fills: defaultFills("star"), ...init }),
    type: "star",
    pointCount: init.pointCount ?? 5,
    innerRatio: init.innerRatio ?? 0.4,
  };
}

export function makeImage(
  rect: Rect,
  src: string,
  init: BaseInit & { cornerRadius?: number } = {}
): ImageNode {
  return {
    ...baseNode(rect, { name: "Image", fills: [makeImagePaint(src)], ...init }),
    type: "image",
    cornerRadius: init.cornerRadius ?? 0,
    cornerRadii: null,
  };
}

export function makeText(
  rect: Rect,
  init: BaseInit & {
    text?: string;
    fontSize?: number;
    fontWeight?: number;
    lineHeight?: number;
    letterSpacing?: number;
    align?: TextAlign;
    color?: string;
  } = {}
): TextNode {
  return {
    ...baseNode(rect, { name: "Text", ...init }),
    type: "text",
    text: init.text ?? "Text",
    fontSize: init.fontSize ?? 24,
    fontWeight: init.fontWeight ?? 500,
    lineHeight: init.lineHeight ?? 1.2,
    letterSpacing: init.letterSpacing ?? 0,
    align: init.align ?? "left",
    color: init.color ?? EDITOR_INK,
  };
}

export function makeLine(rect: Rect, init: BaseInit = {}): LineNode {
  return {
    ...baseNode(rect, {
      name: "Line",
      strokes: defaultStrokes("line"),
      ...init,
    }),
    type: "line",
    rotation: 0,
  };
}

export function makeArrow(rect: Rect, init: BaseInit = {}): ArrowNode {
  return {
    ...baseNode(rect, {
      name: "Arrow",
      strokes: defaultStrokes("arrow"),
      ...init,
    }),
    type: "arrow",
    rotation: 0,
  };
}

/** Bounding box + normalized vertices for a freehand/pen path built from raw
 *  scene-space points. Degenerate (1-D) strokes get a 1px box so they stay
 *  selectable. Shared by {@link makePath} and live drawing updates. */
export function pathGeometry(scenePoints: readonly Vec2[]): {
  x: number;
  y: number;
  width: number;
  height: number;
  points: Vec2[];
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of scenePoints) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX))
    return { x: 0, y: 0, width: 1, height: 1, points: [] };
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  return {
    x: minX,
    y: minY,
    width: Math.max(1, spanX),
    height: Math.max(1, spanY),
    points: scenePoints.map((p) => ({
      x: spanX > 0 ? (p.x - minX) / spanX : 0,
      y: spanY > 0 ? (p.y - minY) / spanY : 0,
    })),
  };
}

export function makePath(
  scenePoints: readonly Vec2[],
  closed = false,
  init: BaseInit = {}
): PathNode {
  const g = pathGeometry(scenePoints);
  return {
    ...baseNode(
      { x: g.x, y: g.y, width: g.width, height: g.height },
      { name: "Path", strokes: [makeStroke(ACCENT_RED, 3)], ...init }
    ),
    type: "path",
    points: g.points,
    closed,
  };
}

/** Create a node for a freshly-drawn rect from a tool. Returns null for
 *  tools that don't create nodes (select/hand/comment). */
export function createNodeForTool(
  tool: ToolId,
  rect: Rect,
  mode: EditorMode = "design"
): SceneNode | null {
  switch (tool) {
    case "frame":
      return makeFrame(rect);
    case "rectangle":
      // Annotation boxes are outlines (a box *around* something), not filled.
      return mode === "annotate"
        ? makeRectangle(rect, {
            fills: [],
            strokes: [makeStroke(ACCENT_RED, 3)],
          })
        : makeRectangle(rect);
    case "ellipse":
      return mode === "annotate"
        ? makeEllipse(rect, {
            fills: [],
            strokes: [makeStroke(ACCENT_RED, 3)],
          })
        : makeEllipse(rect);
    case "text":
      return makeText(rect);
    case "line":
      return makeLine(rect);
    case "arrow":
      return makeArrow(rect);
    case "polygon":
      return makePolygon(rect);
    case "star":
      return makeStar(rect);
    case "blur": {
      const n = makeRectangle(rect, { name: "Blur", fills: [] });
      n.sample = { mode: "blur", amount: SAMPLE_DEFAULT_AMOUNT.blur };
      return n;
    }
    case "pixelate": {
      const n = makeRectangle(rect, { name: "Pixelate", fills: [] });
      n.sample = { mode: "pixelate", amount: SAMPLE_DEFAULT_AMOUNT.pixelate };
      return n;
    }
    case "magnify": {
      const n = makeEllipse(rect, {
        name: "Magnifier",
        fills: [],
        strokes: defaultStrokes("magnify"),
      });
      n.sample = { mode: "magnify", amount: SAMPLE_DEFAULT_AMOUNT.magnify };
      return n;
    }
    case "highlight": {
      const n = makeRectangle(rect, {
        name: "Highlight",
        fills: defaultFills("highlight"),
        strokes: [],
      });
      n.blendMode = "multiply";
      return n;
    }
    case "step": {
      // Force a circle: square the drawn rect, and keep it circular on resize.
      const side = Math.max(rect.width, rect.height);
      const n = makeEllipse(
        { x: rect.x, y: rect.y, width: side, height: side },
        { name: "Step", fills: defaultFills("step"), strokes: [] }
      );
      n.lockAspect = true;
      n.step = { number: 0 }; // addNode assigns the next sequential number
      return n;
    }
    case "callout": {
      const n = makeRectangle(rect, {
        name: "Callout",
        fills: defaultFills("callout"),
        strokes: defaultStrokes("callout"),
      });
      n.callout = { angle: 215, length: 44 }; // points down-left by default
      return n;
    }
    case "spotlight": {
      // A rectangular clear region; the renderers dim the rest of the page
      // around it. Fill-less and stroke-less — the scrim is the whole mark.
      const n = makeRectangle(rect, {
        name: "Spotlight",
        fills: [],
        strokes: [],
      });
      n.spotlight = {
        color: DEFAULT_SPOTLIGHT_COLOR,
        opacity: DEFAULT_SPOTLIGHT_OPACITY,
      };
      return n;
    }
    case "measure": {
      // A dimension is a *line* — its endpoints are the two points being
      // measured, so it inherits endpoint handles, 45°-constrained drawing and
      // nudge from the line node rather than re-inventing them.
      const n = makeLine(rect, {
        name: "Measure",
        strokes: defaultStrokes("measure"),
      });
      n.measure = {
        caps: DEFAULT_MEASURE_CAPS,
        scale: 1,
        unit: DEFAULT_MEASURE_UNIT,
      };
      return n;
    }
    case "stamp": {
      // Square the box so the fit glyph fills its frame and the selection
      // chrome hugs the mark. The canvas also constrains the drag itself, so
      // this is the floor rather than a correction the user can see.
      const side = Math.max(rect.width, rect.height);
      const n = makeRectangle(
        { x: rect.x, y: rect.y, width: side, height: side },
        {
          name: "Stamp",
          fills: defaultFills("stamp"),
          strokes: defaultStrokes("stamp"),
        }
      );
      n.lockAspect = true;
      // `addNode` swaps in the picker's current icon (and renames the layer for
      // it), the way it assigns a step badge its number.
      n.stamp = { kind: DEFAULT_STAMP_KIND };
      return n;
    }
    case "image":
    case "select":
    // Crop is a modal session over the page frame, not a node the canvas draws.
    case "crop":
    case "hand":
    case "pen":
    case "pencil":
    case "comment":
      return null;
  }
}

/** The next sequential badge number for a new step badge: one past the highest
 *  existing badge in the scene (1 when there are none). Computed from the scene
 *  so it survives deletion and undo/redo rather than drifting from a counter. */
export function nextStepNumber(nodes: Record<string, SceneNode>): number {
  let max = 0;
  for (const id of Object.keys(nodes)) {
    const n = nodes[id]?.step?.number;
    if (typeof n === "number" && n > max) max = n;
  }
  return max + 1;
}
