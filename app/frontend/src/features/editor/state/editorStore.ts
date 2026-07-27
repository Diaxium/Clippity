/**
 * Editor document store (Zustand). Single source of truth for the scene
 * graph, selection, active tool, viewport, and undo/redo. The canvas and all
 * three panels read and mutate through this store, so it is intentionally the
 * widest module in the feature.
 *
 * History model mirrors the rest of the app: discrete actions snapshot the
 * present document onto `past`; transient drag updates pass `{ transient }`
 * and skip the snapshot. A gesture calls `pushHistory()` once on pointer-down,
 * then streams `{ transient: true }` updates.
 */

import { create } from "zustand";

import {
  clampZoom,
  MIN_SIZE,
  resizeFrame,
  rotatedAABB,
  unionBounds,
  type ResizeHandle,
} from "../geometry";
import {
  isContainer,
  isLineLike,
  makeFrame,
  makeShadow,
  makeSolidPaint,
  makeStroke,
  nodeBounds,
  nextNodeId,
  nextStepNumber,
  toolInMode,
  DEFAULT_STAMP_KIND,
  type Effect,
  type EditorMode,
  type EffectType,
  type InspectorTab,
  type Paint,
  type Rect,
  type SceneDoc,
  type SceneNode,
  type StampKind,
  type Stroke,
  type ToolId,
  type Vec2,
} from "../types";
import type { Guide } from "../snapping";
import type { DockSide } from "../lib/dock";
import type { EntryList, EntryRef } from "../lib/multi";
import {
  absorbRootsIntoPage,
  applyCropAspect,
  cropChanges,
  pageFrameId,
  rectOfNode,
  roundCrop,
} from "../lib/crop";
import {
  DEFAULT_CONTENT_RADIUS,
  DEFAULT_PAGE_PADDING,
  backdropPreset,
  pageContent,
  pagePadding,
  setContentRadius as applyContentRadius,
  setContentShadow as applyContentShadow,
  setPageBackdrop as applyPageBackdrop,
  setPagePadding as applyPagePadding,
  setWindowChrome as applyWindowChrome,
} from "../lib/page";
import {
  DEFAULT_CHROME_RADIUS,
  canCarryChrome,
  chromePreset,
  clampChromeHeight,
  makeChrome,
} from "../lib/chrome";
import { stampLabel } from "../lib/stamps";

export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

/** A pointer gesture currently driving the canvas. Mirrors the canvas's
 *  internal gesture union, narrowed to what the UI (hints, chrome) needs. */
export type GestureKind =
  | "pan"
  | "marquee"
  | "draw"
  | "move"
  | "resize"
  | "rotate"
  | "endpoint"
  | "gradient"
  | "tail"
  | "crop";

/** A transient transform readout (live W×H, position, or angle) anchored at a
 *  scene point — shown beside the selection during a drag/resize/rotate. */
export interface TransformHud {
  text: string;
  sx: number;
  sy: number;
  /** True while a resize is holding the aspect ratio (Shift or lockAspect) — the
   *  HUD shows a small "locked" cue. */
  aspectLocked?: boolean;
}

/** In-progress pen path: placed anchors plus the live cursor for the
 *  rubber-band preview. Non-null only while the pen tool has an open path. */
export interface PenSession {
  points: Vec2[];
  cursor: Vec2 | null;
}

export type DocStatus = "draft" | "edited" | "saved";

export interface SceneInit {
  rootIds: string[];
  nodes: Record<string, SceneNode>;
  docName: string;
  sourceId: string | null;
  select?: string[];
  /** Initial document status; defaults to `"draft"`. A restored saved scene
   *  loads as `"saved"`. */
  status?: DocStatus;
}

export type AlignMode =
  | "left"
  | "center-h"
  | "right"
  | "top"
  | "center-v"
  | "bottom"
  | "distribute-h"
  | "distribute-v";

export type ContextMenuKind = "node" | "canvas";

export interface ContextMenuState {
  /** Cursor position in the editor's coordinate space (page px). */
  x: number;
  y: number;
  /** Scene coords under the cursor, used by "Paste here". */
  sceneX: number;
  sceneY: number;
  kind: ContextMenuKind;
}

/** What the floating color editor is editing — a fill, or a solid color on a
 *  stroke / effect / text node. Resolved to the live paint by the popover. */
export type ColorTarget =
  | { kind: "fill"; nodeId: string; fillId: string }
  | { kind: "stroke"; nodeId: string; strokeId: string }
  | { kind: "effect"; nodeId: string; effectId: string }
  | { kind: "text"; nodeId: string };

export interface ColorEditorState {
  target: ColorTarget;
  /**
   * The rest of the selection this edit also applies to (P3 batch apply). The
   * popover *reads* the primary `target` — one swatch, one gradient, one set of
   * stops — but *writes* to the primary plus these, so opening the fill editor
   * with three shapes selected paints all three. Empty for a single selection.
   *
   * Peers always share the primary's `kind`, because they're resolved by
   * `lib/multi.entriesAt` from the same row of the same list.
   */
  peers: readonly ColorTarget[];
  /** Anchor in screen px (the clicked row) — the popover floats next to it. */
  x: number;
  y: number;
}

/**
 * An open crop session. Crop is **modal**: while a session exists the canvas
 * stops picking/drawing and every pointer gesture edits `rect` instead. Nothing
 * touches the document until `commitCrop` — cancelling (or switching tools)
 * simply drops the session, which is why the pending rect lives here rather
 * than as a live mutation on the page frame.
 */
export interface CropSession {
  /** The page frame this crop resizes (see `lib/crop.pageFrameId`). */
  nodeId: string;
  /** Pending crop window in scene space. */
  rect: Rect;
  /** The page rect when the session opened — backs Reset and the "Original"
   *  aspect chip. */
  original: Rect;
  /** Locked width ÷ height, or null for a freeform drag. */
  aspect: number | null;
}

/** A detached, pre-cloned set of subtrees (self-contained id→node map). */
interface ClipboardFragment {
  rootIds: string[];
  nodes: Record<string, SceneNode>;
}

type ZMode = "front" | "forward" | "backward" | "back";
const DUP_OFFSET = 24;

/** Right-inspector width bounds (px). The default matches the `w-64` the panel
 *  was fixed at; the minimum keeps two-up number fields legible, and the
 *  maximum stops a drag from swallowing the canvas. */
export const PANEL_WIDTH_MIN = 224;
export const PANEL_WIDTH_DEFAULT = 256;
export const PANEL_WIDTH_MAX = 480;

export const clampPanelWidth = (px: number): number =>
  Math.round(Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, px)));

interface MutateOptions {
  transient?: boolean;
}

export interface EditorState {
  // ----- document -----
  rootIds: string[];
  nodes: Record<string, SceneNode>;
  docName: string;
  docStatus: DocStatus;
  /** Capture id (file path) this scene was loaded from; null for a blank doc. */
  sourceId: string | null;

  // ----- session -----
  selectedIds: string[];
  tool: ToolId;
  /**
   * The icon a freshly-drawn stamp takes. Session state rather than a document
   * property: it's the picker's current choice, the way a tool group remembers
   * its last-used sub-tool, and `addNode` stamps it onto the new node — the same
   * seam step badges get their number from.
   */
  stampKind: StampKind;
  /** Annotation (fast markup) vs Design (full editor) — see Workstream M. */
  mode: EditorMode;
  viewport: Viewport;
  /**
   * Per-mode viewport memory. Annotation and Design lay the workspace out
   * differently (Design adds the Layers rail), so carrying one shared viewport
   * across a switch slides the document off-centre under the new chrome. On
   * `setMode` the outgoing mode's viewport is stashed here and the incoming
   * mode's is restored; a mode not yet visited inherits the current viewport
   * rather than snapping. Deliberately *not* `fitView()` on switch — that would
   * discard a zoom the user chose on purpose.
   */
  viewportByMode: Partial<Record<EditorMode, Viewport>>;
  /** Id of the text node currently being edited inline, if any. */
  editingTextId: string | null;

  /** Detached, pre-cloned fragment from the last copy. */
  clipboard: ClipboardFragment | null;
  /** Open context-menu descriptor, or null when closed. */
  contextMenu: ContextMenuState | null;
  /** The floating color editor, or null when closed. */
  colorEditor: ColorEditorState | null;
  /** Open crop session, or null. Non-null implies `tool === "crop"`. */
  cropSession: CropSession | null;
  /** Last measured canvas viewport size (px); powers zoom-to-fit from anywhere. */
  canvasSize: { width: number; height: number };

  // ----- inspector chrome -----
  /**
   * Where the inspector lives, per mode: an edge to dock to, or `null` to
   * float. Per-mode because the two modes want different defaults — Design is a
   * rail-shaped workflow, Annotation wants the canvas — but both are now the
   * same mechanism, so either can be dragged into either shape.
   */
  inspectorDock: Record<EditorMode, DockSide | null>;
  setInspectorDock(mode: EditorMode, side: DockSide | null): void;
  /** Edge that would receive a drop during a panel drag; drives the drop-zone
   *  highlight. Transient — never persisted, cleared on pointer-up. */
  dockPreview: DockSide | null;
  setDockPreview(side: DockSide | null): void;

  /**
   * Right-inspector section collapse, keyed by section id; an id absent here is
   * open. Held in the store rather than each section's local state so a section
   * unmounting — switching to the Export tab, or selecting a node type that
   * hides it — doesn't silently reset the user's choice. Session-scoped: not
   * written to Settings, so it doesn't survive a restart.
   */
  sectionsOpen: Record<string, boolean>;
  toggleSection(id: string): void;
  /** Force a section open/closed — used by "add fill/stroke/effect" actions so
   *  the row you just created isn't created inside a collapsed section. */
  setSectionOpen(id: string, open: boolean): void;
  /**
   * Which family of properties the inspector is showing. The section list grew
   * past the point where one scroll could stay legible, so it is split three
   * ways: `style` (how the selection looks), `arrange` (where it sits), and
   * `inspect` (a read-only readout of both). Not per-mode — the tab you left
   * the inspector on is a habit, and Annotate/Design switching shouldn't
   * silently reshuffle it.
   */
  inspectorTab: InspectorTab;
  setInspectorTab(tab: InspectorTab): void;
  /** Right-inspector width in px (drag-resizable), clamped to
   *  {@link PANEL_WIDTH_MIN}…{@link PANEL_WIDTH_MAX}. */
  panelWidth: number;
  setPanelWidth(px: number): void;

  // ----- canvas affordances -----
  /** Faint dot grid behind the scene (toggleable). */
  showGrid: boolean;
  /** Alignment snapping during move/resize (Cmd/Ctrl bypasses per-gesture). */
  snapEnabled: boolean;
  /** Top + left rulers (toggleable via the view options menu). */
  showRulers: boolean;
  /** Cursor position in scene space (for ruler indicators), or null off-canvas. */
  cursor: Vec2 | null;
  /** Live alignment guides; non-empty only mid-gesture. */
  guides: Guide[];
  /** Live transform readout; non-null only mid-gesture. */
  transformHud: TransformHud | null;
  /** Layer id requested to enter inline rename (consumed by its row). */
  renamingId: string | null;
  /** Kind of pointer gesture in flight (drives hint text + handle hiding). */
  activeGesture: GestureKind | null;
  /** Fill id whose gradient is being edited on-canvas (shows the gradient
   *  handles); null when no gradient editor is open. Set by the Fill panel. */
  gradientEditFillId: string | null;
  /** Active pen-tool path (anchors + cursor); null when no pen path is open. */
  pen: PenSession | null;

  // ----- keyboard / overlays -----
  /** Temporary pan (Space held). The canvas grab-pans while true without
   *  changing the active tool, then restores the tool on release. */
  tempPan: boolean;
  /** Keyboard-shortcuts help overlay visibility (`?`). */
  helpOpen: boolean;
  /** Bumped to ask the inspector to reveal its Export tab (Mod+Shift+E). */
  exportRequest: number;

  // ----- history -----
  past: SceneDoc[];
  future: SceneDoc[];
  /** Open `beginHistory`/`endHistory` transactions; >0 suppresses per-mutation
   *  snapshots so a drag/nudge collapses to a single undo entry. */
  txnDepth: number;
  /** While a transaction is open, true until its first real change snapshots. */
  txnPendingSnapshot: boolean;

  // ----- lifecycle -----
  loadScene(init: SceneInit): void;
  /** Mark the document saved (after a successful scene save). */
  markSaved(): void;

  // ----- session setters -----
  setTool(tool: ToolId): void;
  /** Choose the icon the next stamp is drawn with. */
  setStampKind(kind: StampKind): void;
  /** Switch mode; keeps the scene + selection, and resets the tool to `select`
   *  if the active one isn't available in the new mode. */
  setMode(mode: EditorMode): void;
  select(ids: string[]): void;
  toggleSelection(id: string): void;
  selectAll(): void;
  clearSelection(): void;
  setEditingText(id: string | null): void;
  /** Lock (or unlock) every selected node in one undo step. Toggles to unlock
   *  only when the whole selection is already locked. */
  toggleLockSelected(): void;
  /** Hide (or show) every selected node in one undo step. Toggles to show only
   *  when the whole selection is already hidden. */
  toggleHideSelected(): void;
  /** Grow/shrink every selected box node by `dw`×`dh` px (one undo step inside a
   *  history transaction). `proportional` (or a node's lockAspect) derives the
   *  other axis from the driven one. Line-like + locked nodes are skipped. */
  resizeSelectedBy(
    dw: number,
    dh: number,
    opts?: { proportional?: boolean }
  ): void;

  // ----- node mutations -----
  addNode(node: SceneNode, parentId?: string | null): void;
  updateNode(id: string, patch: Partial<SceneNode>, opts?: MutateOptions): void;
  updateNodes(
    ids: readonly string[],
    patch: Partial<SceneNode>,
    opts?: MutateOptions
  ): void;
  /**
   * Patch each id with a patch *derived from that node* — the per-node batch
   * `updateNodes`' single shared patch can't express. Needed wherever a batch
   * edit depends on the node it lands on: W/H under each node's own aspect
   * ratio, per-corner radii built from each node's existing corners. Returning
   * `null` skips a node. One undo step for the whole batch.
   */
  updateEach(
    ids: readonly string[],
    patch: (node: SceneNode) => Partial<SceneNode> | null,
    opts?: MutateOptions
  ): void;
  /**
   * Move every id so its bounds sit at `x` / `y` (whichever is supplied),
   * carrying descendants the way a drag does — nodes hold absolute coords, so
   * repositioning a frame has to move its contents too. This is what the
   * inspector's X/Y fields write through; patching `x` directly would slide a
   * frame out from under its children. One undo step.
   */
  placeNodes(
    ids: readonly string[],
    at: { x?: number; y?: number },
    opts?: MutateOptions
  ): void;
  moveNodes(
    ids: readonly string[],
    dx: number,
    dy: number,
    opts?: MutateOptions
  ): void;
  resizeNode(
    id: string,
    handle: ResizeHandle,
    pointer: { x: number; y: number },
    start: Rect,
    rotation: number,
    opts?: MutateOptions & { keepAspect?: boolean; fromCenter?: boolean }
  ): void;
  rotateNode(id: string, rotation: number, opts?: MutateOptions): void;
  setText(id: string, text: string, opts?: MutateOptions): void;
  removeNodes(ids: readonly string[]): void;
  removeSelected(): void;
  setVisible(id: string, visible: boolean): void;
  setLocked(id: string, locked: boolean): void;
  renameNode(id: string, name: string): void;
  /** Ask a layer row to enter inline rename; the row consumes + clears it. */
  requestRename(id: string): void;
  clearRename(): void;
  reorderNode(dragId: string, targetId: string, edge: "before" | "after"): void;
  align(mode: AlignMode): void;
  /** Wrap the (top-level) selection in a new non-clipping "Group" frame,
   *  preserving paint order + z-position; selects the group. One undo step. */
  group(): void;
  /** Dissolve every selected frame, splicing its children back into the
   *  frame's slot; selects the freed children. One undo step. */
  ungroup(): void;

  // ----- clipboard / z-order -----
  duplicateNodes(ids: readonly string[], offset?: number): void;
  copyNodes(ids: readonly string[]): void;
  pasteClipboard(at?: { x: number; y: number }): void;
  bringToFront(ids: readonly string[]): void;
  bringForward(ids: readonly string[]): void;
  sendBackward(ids: readonly string[]): void;
  sendToBack(ids: readonly string[]): void;

  // ----- context menu / canvas metrics -----
  openContextMenu(state: ContextMenuState): void;
  closeContextMenu(): void;
  openColorEditor(
    target: ColorTarget,
    x: number,
    y: number,
    /** Additional targets the same edit applies to (P3) — see `peers`. */
    peers?: readonly ColorTarget[]
  ): void;
  closeColorEditor(): void;
  setCanvasSize(width: number, height: number): void;
  fitView(): void;
  /** Zoom + pan so the current selection fills the viewport; no-op when nothing
   *  is selected (or the selection has no area). */
  zoomToSelection(vw: number, vh: number): void;
  /** Fit the selection into the measured canvas viewport from anywhere. */
  fitSelection(): void;
  /** Re-center the scene in the viewport, keeping the current zoom. */
  centerView(): void;

  // ----- canvas affordances -----
  setShowGrid(show: boolean): void;
  toggleGrid(): void;
  setShowRulers(show: boolean): void;
  toggleRulers(): void;
  setSnapEnabled(enabled: boolean): void;
  toggleSnap(): void;
  setCursor(cursor: Vec2 | null): void;
  setGuides(guides: Guide[]): void;
  setTransformHud(hud: TransformHud | null): void;
  setPen(pen: PenSession | null): void;
  setActiveGesture(kind: GestureKind | null): void;
  setGradientEditFill(fillId: string | null): void;
  setTempPan(on: boolean): void;
  setHelpOpen(open: boolean): void;
  toggleHelp(): void;
  requestExport(): void;

  // ----- paint / stroke / effect -----
  // The singular forms address one node; the plural forms take the
  // `{nodeId, entryId}` refs `lib/multi.entriesAt` resolves for a multi-select
  // row edit (Fork P-F1, edit-by-index) and land as **one** undo step. Every
  // singular action delegates to its plural, so there is one implementation.
  addFill(id: string): void;
  updateFill(id: string, fillId: string, patch: Partial<Paint>): void;
  removeFill(id: string, fillId: string): void;
  addFills(ids: readonly string[]): void;
  updateFills(refs: readonly EntryRef[], patch: Partial<Paint>): void;
  removeFills(refs: readonly EntryRef[]): void;
  addStroke(id: string): void;
  updateStroke(id: string, strokeId: string, patch: Partial<Stroke>): void;
  removeStroke(id: string, strokeId: string): void;
  addStrokes(ids: readonly string[]): void;
  updateStrokes(refs: readonly EntryRef[], patch: Partial<Stroke>): void;
  removeStrokes(refs: readonly EntryRef[]): void;
  addEffect(id: string, type?: EffectType): void;
  updateEffect(id: string, effectId: string, patch: Partial<Effect>): void;
  removeEffect(id: string, effectId: string): void;
  addEffects(ids: readonly string[], type?: EffectType): void;
  updateEffects(refs: readonly EntryRef[], patch: Partial<Effect>): void;
  removeEffects(refs: readonly EntryRef[]): void;

  // ----- crop (page frame) -----
  /** Open a crop session on the page frame. No-op when the document has no
   *  single page frame to crop (see `lib/crop.pageFrameId`). */
  beginCrop(): void;
  /** Replace the pending crop window (drag updates; no history). */
  setCropRect(rect: Rect): void;
  /** Lock/unlock the crop ratio, re-fitting the pending rect about its centre. */
  setCropAspect(aspect: number | null): void;
  /** Restore the crop window to the page's rect at session start. */
  resetCrop(): void;
  /** Apply the pending crop to the page frame — one undo step — and leave the
   *  session. A crop that doesn't move anything records no history. */
  commitCrop(): void;

  // ----- page backdrop (Fork F4, ADR 0020) -----
  /** Resize the page so the capture sits inside `padding` px of margin. Same
   *  edit crop makes (the page frame's rect), so padding *is* an outward crop
   *  with a number instead of a drag. No-op without a page frame + capture. */
  setPagePadding(padding: number): void;
  /** Paint a stock backdrop on the page frame. Applying a non-empty backdrop to
   *  a page with no padding also opens a default margin (and rounds the
   *  capture's corners) in the **same undo step** — otherwise the backdrop
   *  would be entirely hidden behind the capture and read as a no-op. */
  applyBackdrop(presetId: string): void;
  /** Round the capture's corners. */
  setContentRadius(radius: number): void;
  /** Toggle the capture's lift shadow. */
  setContentShadow(on: boolean): void;

  // ----- window chrome (Fork F4, ADR 0022) -----
  /** Frame the capture in a stock title bar (or `"none"` to remove it). The
   *  page grows to make room for the bar in the **same undo step**, and a first
   *  chrome on a square-cornered capture also rounds it — a window with sharp
   *  corners reads as a bug rather than a style. No-op without a page + capture. */
  applyChrome(presetId: string): void;
  /** Set the title-bar text (empty draws no label). */
  setChromeTitle(title: string): void;
  /** Set the title-bar height; the page's margin is preserved around it. */
  setChromeHeight(height: number): void;
  /** Discard the session without touching the document. */
  cancelCrop(): void;

  // ----- doc meta -----
  setDocName(name: string): void;

  // ----- viewport -----
  setZoom(
    zoom: number,
    anchor?: { x: number; y: number; vw: number; vh: number }
  ): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  zoomToFit(vw: number, vh: number): void;
  panBy(dx: number, dy: number): void;
  setPan(panX: number, panY: number): void;

  // ----- history -----
  pushHistory(): void;
  /** Open a history transaction: the next real mutation snapshots once, and
   *  further mutations until {@link endHistory} coalesce into it. Pairs with a
   *  drag/scrub or keyboard-nudge gesture so it yields one undo step. */
  beginHistory(): void;
  endHistory(): void;
  undo(): void;
  redo(): void;
}

// --------- pure doc helpers ----------

function currentDoc(s: EditorState): SceneDoc {
  return { rootIds: s.rootIds, nodes: s.nodes };
}

/** ids of `parentId`'s children (frame) or the scene's top-level roots. */
function childIds(doc: SceneDoc, parentId: string | null): readonly string[] {
  if (parentId) {
    const parent = doc.nodes[parentId];
    return parent && isContainer(parent) ? parent.children : [];
  }
  return doc.rootIds;
}

/** Locate a node's parent: a frame id, or null if it sits at the page root. */
function parentOf(doc: SceneDoc, id: string): string | null {
  for (const nid of Object.keys(doc.nodes)) {
    const n = doc.nodes[nid];
    if (n && isContainer(n) && n.children.includes(id)) return nid;
  }
  return null;
}

/** All transitive descendant ids of a node (excludes the node itself). */
function descendantIds(doc: SceneDoc, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    const node = doc.nodes[cur];
    if (node && isContainer(node)) {
      for (const c of node.children) {
        out.push(c);
        stack.push(c);
      }
    }
  }
  return out;
}

function resolveNodes(
  nodes: Record<string, SceneNode>,
  ids: readonly string[]
): SceneNode[] {
  const out: SceneNode[] = [];
  for (const id of ids) {
    const n = nodes[id];
    if (n) out.push(n);
  }
  return out;
}

/** Deepest frame in the scene whose bounds contain `point`, excluding `skip`
 *  ids. Used to nest freshly-drawn nodes under the frame they land on. */
function frameAt(
  doc: SceneDoc,
  point: { x: number; y: number },
  skip: ReadonlySet<string>
): string | null {
  let found: string | null = null;
  const walk = (ids: readonly string[]) => {
    for (const id of ids) {
      const node = doc.nodes[id];
      if (!node || !isContainer(node) || skip.has(id) || !node.visible)
        continue;
      const b = nodeBounds(node);
      if (
        point.x >= b.x &&
        point.x <= b.x + b.width &&
        point.y >= b.y &&
        point.y <= b.y + b.height
      ) {
        found = id;
        walk(node.children);
      }
    }
  };
  walk(doc.rootIds);
  return found;
}
/** Shallow-copy the node map, replacing one node by id. */
function withNode(
  nodes: Record<string, SceneNode>,
  id: string,
  next: SceneNode
): Record<string, SceneNode> {
  return { ...nodes, [id]: next };
}

/**
 * Cap on retained undo snapshots. Each entry holds a whole-doc snapshot
 * (`{rootIds, nodes}`); unchanged nodes are shared by reference, but without a
 * bound a long editing session grows `past` — and the superseded node objects
 * it pins — without limit. 100 steps is deep enough for real editing while
 * keeping memory bounded.
 */
const HISTORY_LIMIT = 100;

/** Append a snapshot to the undo stack, dropping the oldest entries past the
 *  {@link HISTORY_LIMIT} so history can't grow unbounded. */
function pushPast(past: readonly SceneDoc[], snapshot: SceneDoc): SceneDoc[] {
  const next = [...past, snapshot];
  return next.length > HISTORY_LIMIT
    ? next.slice(next.length - HISTORY_LIMIT)
    : next;
}

const ZOOM_STEPS = [
  0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8, 16, 32, 64,
];

function nextZoom(current: number, dir: 1 | -1): number {
  if (dir === 1) {
    for (const z of ZOOM_STEPS) if (z > current + 1e-6) return z;
    return current;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const z = ZOOM_STEPS[i]!;
    if (z < current - 1e-6) return z;
  }
  return current;
}

export const useEditorStore = create<EditorState>((set, get) => {
  /**
   * Apply a doc transform. Snapshots history unless `transient`. Inside a
   * `beginHistory`/`endHistory` transaction the snapshot is taken once — on the
   * first real change — so a whole drag/nudge collapses to a single undo step.
   */
  const mutate = (
    fn: (doc: SceneDoc) => SceneDoc,
    opts?: MutateOptions
  ): void => {
    set((s) => {
      const prev = currentDoc(s);
      const next = fn(prev);
      if (next === prev) return {};
      const base = {
        rootIds: next.rootIds,
        nodes: next.nodes,
        // Any real change means unsaved work — flip draft *and* saved to edited.
        docStatus: "edited" as DocStatus,
      };
      if (opts?.transient) return base;
      if (s.txnDepth > 0) {
        // Snapshot lazily: only the transaction's first real change records the
        // pre-gesture doc; later changes fold into it.
        return s.txnPendingSnapshot
          ? {
              ...base,
              past: pushPast(s.past, prev),
              future: [] as SceneDoc[],
              txnPendingSnapshot: false,
            }
          : base;
      }
      return {
        ...base,
        past: pushPast(s.past, prev),
        future: [] as SceneDoc[],
      };
    });
  };

  /** Patch a single node by id, preserving its concrete type. */
  const patchNode = (
    doc: SceneDoc,
    id: string,
    patch: Partial<SceneNode>
  ): SceneDoc => {
    const node = doc.nodes[id];
    if (!node) return doc;
    const next = { ...node, ...patch } as SceneNode;
    return { rootIds: doc.rootIds, nodes: withNode(doc.nodes, id, next) };
  };

  /**
   * Translate each id by its own delta, carrying descendants — nodes hold
   * absolute coords, so a container's contents have to travel with it. A locked
   * node sits out along with its whole subtree.
   *
   * Shared by `moveNodes` (one delta for every id) and `placeNodes` (a delta per
   * id, derived from where each node should land).
   */
  const translateBy = (
    d: SceneDoc,
    deltas: ReadonlyMap<string, Vec2>
  ): SceneDoc => {
    const moves = new Map<string, Vec2>();
    // Descendants first, then the named nodes — so a node that is both selected
    // and a descendant of another selected node keeps its *own* delta rather
    // than inheriting its ancestor's.
    for (const [id, delta] of deltas) {
      const node = d.nodes[id];
      if (!node || node.locked) continue;
      for (const desc of descendantIds(d, id)) moves.set(desc, delta);
    }
    for (const [id, delta] of deltas) {
      const node = d.nodes[id];
      if (!node || node.locked) continue;
      moves.set(id, delta);
    }
    let nodes = d.nodes;
    for (const [id, delta] of moves) {
      if (delta.x === 0 && delta.y === 0) continue;
      const node = nodes[id];
      if (!node) continue;
      nodes = withNode(nodes, id, {
        ...node,
        x: node.x + delta.x,
        y: node.y + delta.y,
      });
    }
    return nodes === d.nodes ? d : { rootIds: d.rootIds, nodes };
  };

  // ----- fills / strokes / effects, as one implementation -----
  // All three are `{id}`-keyed lists hanging off the node, so add / patch /
  // remove is written once over a `key` and reused nine ways. The batch shape is
  // the primitive here and the single-node actions delegate into it — that's
  // what makes a multi-select row edit (Fork P-F1) one undo step rather than one
  // per node.

  /** The uniform shape the three paint lists share. */
  interface ListEntry {
    id: string;
  }

  const listOf = (node: SceneNode, key: EntryList): readonly ListEntry[] =>
    node[key] as readonly ListEntry[];

  /** Write a rebuilt list back as a node patch, preserving the concrete type. */
  const withList = (
    node: SceneNode,
    key: EntryList,
    list: readonly ListEntry[]
  ): SceneNode => ({ ...node, [key]: list }) as SceneNode;

  /**
   * Rewrite one list on each node named by `refs` — grouped by node first, so a
   * node holding several targeted entries is still rewritten once, and the whole
   * batch lands in a single `mutate` (one undo step).
   */
  const editEntries = (
    refs: readonly EntryRef[],
    key: EntryList,
    edit: (
      list: readonly ListEntry[],
      targets: ReadonlySet<string>
    ) => readonly ListEntry[]
  ): void =>
    mutate((d) => {
      const byNode = new Map<string, Set<string>>();
      for (const { nodeId, entryId } of refs) {
        const seen = byNode.get(nodeId);
        if (seen) seen.add(entryId);
        else byNode.set(nodeId, new Set([entryId]));
      }
      let nodes = d.nodes;
      for (const [nodeId, targets] of byNode) {
        const node = nodes[nodeId];
        if (!node) continue;
        nodes = withNode(
          nodes,
          nodeId,
          withList(node, key, edit(listOf(node, key), targets))
        );
      }
      return nodes === d.nodes ? d : { rootIds: d.rootIds, nodes };
    });

  const patchEntries = (
    refs: readonly EntryRef[],
    key: EntryList,
    patch: object
  ): void =>
    editEntries(refs, key, (list, targets) =>
      list.map((e) => (targets.has(e.id) ? { ...e, ...patch } : e))
    );

  const dropEntries = (refs: readonly EntryRef[], key: EntryList): void =>
    editEntries(refs, key, (list, targets) =>
      list.filter((e) => !targets.has(e.id))
    );

  /** Append a freshly made entry to `key` on every id — one undo step. `make` is
   *  called per node so each gets its own entry id. */
  const appendEntries = (
    ids: readonly string[],
    key: EntryList,
    make: () => ListEntry
  ): void =>
    mutate((d) => {
      let nodes = d.nodes;
      for (const id of ids) {
        const node = nodes[id];
        if (!node) continue;
        nodes = withNode(
          nodes,
          id,
          withList(node, key, [...listOf(node, key), make()])
        );
      }
      return nodes === d.nodes ? d : { rootIds: d.rootIds, nodes };
    });

  /**
   * The page frame plus the capture it wraps — the two anchors every backdrop
   * action needs (ADR 0020).
   *
   * Null when the document has no page frame (`lib/crop.pageFrameId`) or no
   * image, which is what keeps the Backdrop panel and its actions inert on a
   * blank document — the same way crop stays inert. Also null when the capture
   * *is* the page (a frame carrying the image fill directly): padding would
   * then be measured against the very rect it resizes, so there is no
   * well-defined margin to author.
   */
  const pageTargets = (
    s: EditorState
  ): { pageId: string; content: { id: string; rect: Rect } } | null => {
    const pageId = pageFrameId(s.rootIds, s.nodes);
    if (!pageId) return null;
    const content = pageContent(s.nodes);
    if (!content || content.id === pageId) return null;
    return { pageId, content };
  };

  const zorder = (ids: readonly string[], mode: ZMode): void => {
    const s = get();
    const groups = groupSelectedByParent(currentDoc(s), ids);
    if (groups.size === 0) return;
    mutate((d) => {
      const nodes = { ...d.nodes };
      let rootIds = d.rootIds;
      for (const [parentId, sel] of groups) {
        if (parentId === null) {
          rootIds = applyZOrder(rootIds, sel, mode);
        } else {
          const parent = nodes[parentId];
          if (parent && isContainer(parent)) {
            nodes[parentId] = {
              ...parent,
              children: applyZOrder(parent.children, sel, mode),
            };
          }
        }
      }
      return { rootIds, nodes };
    });
  };

  return {
    rootIds: [],
    nodes: {},
    docName: "Untitled",
    docStatus: "draft",
    sourceId: null,
    selectedIds: [],
    tool: "select",
    stampKind: DEFAULT_STAMP_KIND,
    mode: "annotate",
    viewport: { zoom: 1, panX: 0, panY: 0 },
    viewportByMode: {},
    editingTextId: null,
    past: [],
    future: [],
    txnDepth: 0,
    txnPendingSnapshot: false,
    clipboard: null,
    contextMenu: null,
    colorEditor: null,
    cropSession: null,
    canvasSize: { width: 0, height: 0 },
    // Stroke + Effects start collapsed (they did as local state); every other
    // section is open by default via the absent-means-open rule.
    sectionsOpen: { stroke: false, effects: false },
    inspectorTab: "style",
    panelWidth: PANEL_WIDTH_DEFAULT,
    // Design keeps the rail; Annotation floats so markup gets the full canvas.
    inspectorDock: { annotate: null, design: "right" },
    dockPreview: null,
    showGrid: true,
    showRulers: true,
    snapEnabled: true,
    cursor: null,
    guides: [],
    transformHud: null,
    renamingId: null,
    activeGesture: null,
    gradientEditFillId: null,
    pen: null,
    tempPan: false,
    helpOpen: false,
    exportRequest: 0,

    loadScene: (init) =>
      set({
        rootIds: init.rootIds,
        nodes: init.nodes,
        docName: init.docName,
        docStatus: init.status ?? "draft",
        sourceId: init.sourceId,
        selectedIds: init.select ?? [],
        tool: "select",
        mode: "annotate",
        editingTextId: null,
        cursor: null,
        guides: [],
        transformHud: null,
        renamingId: null,
        activeGesture: null,
        gradientEditFillId: null,
        colorEditor: null,
        cropSession: null,
        pen: null,
        tempPan: false,
        helpOpen: false,
        past: [],
        future: [],
        txnDepth: 0,
        txnPendingSnapshot: false,
        viewport: { zoom: 1, panX: 0, panY: 0 },
        // A new document invalidates both modes' remembered viewports.
        viewportByMode: {},
      }),

    markSaved: () =>
      set((s) => (s.docStatus === "saved" ? {} : { docStatus: "saved" })),

    // Crop is a modal session rather than a drag tool, so tool switching owns
    // its lifecycle: picking Crop opens the session (and clears the selection,
    // since crop acts on the page, not on nodes), and picking anything else
    // discards it — `commitCrop` is the only path that writes to the document.
    setTool: (tool) =>
      set((s) => {
        if (tool === "crop") {
          if (s.cropSession) return { tool };
          const nodeId = pageFrameId(s.rootIds, s.nodes);
          const node = nodeId ? s.nodes[nodeId] : undefined;
          // Nothing page-shaped to crop — leave the active tool alone rather
          // than stranding the user in an inert mode.
          if (!nodeId || !node) return {};
          const rect = rectOfNode(node);
          return {
            tool,
            cropSession: { nodeId, rect, original: rect, aspect: null },
            selectedIds: [],
            editingTextId: null,
          };
        }
        return {
          tool,
          cropSession: null,
          editingTextId: tool === "text" ? s.editingTextId : null,
        };
      }),

    setStampKind: (stampKind) => set({ stampKind }),

    setMode: (mode) =>
      set((s) =>
        s.mode === mode
          ? {}
          : {
              mode,
              tool: toolInMode(s.tool, mode) ? s.tool : "select",
              // Stash where the user was in the mode they're leaving, and
              // restore where they left the one they're entering.
              viewportByMode: { ...s.viewportByMode, [s.mode]: s.viewport },
              viewport: s.viewportByMode[mode] ?? s.viewport,
            }
      ),

    select: (ids) =>
      set((s) => ({
        selectedIds: [...ids],
        // A selection change dismisses the floating color editor.
        ...(s.colorEditor
          ? { colorEditor: null, gradientEditFillId: null }
          : {}),
      })),
    toggleSelection: (id) =>
      set((s) => ({
        selectedIds: s.selectedIds.includes(id)
          ? s.selectedIds.filter((x) => x !== id)
          : [...s.selectedIds, id],
      })),
    selectAll: () => set((s) => ({ selectedIds: [...s.rootIds] })),
    clearSelection: () => set({ selectedIds: [], editingTextId: null }),
    setEditingText: (id) => set({ editingTextId: id }),

    toggleLockSelected: () => {
      const { selectedIds: ids, nodes } = get();
      if (ids.length === 0) return;
      const next = !ids.every((id) => nodes[id]?.locked);
      mutate((d) => {
        let n = d.nodes;
        for (const id of ids) {
          const node = n[id];
          if (!node || node.locked === next) continue;
          n = withNode(n, id, { ...node, locked: next });
        }
        return n === d.nodes ? d : { rootIds: d.rootIds, nodes: n };
      });
    },
    toggleHideSelected: () => {
      const { selectedIds: ids, nodes } = get();
      if (ids.length === 0) return;
      const next = ids.every((id) => nodes[id]?.visible);
      mutate((d) => {
        let n = d.nodes;
        for (const id of ids) {
          const node = n[id];
          if (!node || node.visible === !next) continue;
          n = withNode(n, id, { ...node, visible: !next });
        }
        return n === d.nodes ? d : { rootIds: d.rootIds, nodes: n };
      });
    },
    resizeSelectedBy: (dw, dh, opts) => {
      const ids = get().selectedIds;
      if (ids.length === 0 || (dw === 0 && dh === 0)) return;
      mutate((d) => {
        let n = d.nodes;
        for (const id of ids) {
          const node = n[id];
          if (!node || node.locked || isLineLike(node)) continue;
          let width = Math.max(MIN_SIZE, node.width + dw);
          let height = Math.max(MIN_SIZE, node.height + dh);
          if ((opts?.proportional || node.lockAspect) && node.height > 0) {
            const ratio = node.width / node.height;
            if (dw !== 0) height = Math.max(MIN_SIZE, width / ratio);
            else if (dh !== 0) width = Math.max(MIN_SIZE, height * ratio);
          }
          if (width === node.width && height === node.height) continue;
          n = withNode(n, id, { ...node, width, height });
        }
        return n === d.nodes ? d : { rootIds: d.rootIds, nodes: n };
      });
    },

    addNode: (node, parentId) => {
      const s = get();
      const doc = currentDoc(s);
      // Step badges auto-increment from whatever's already in the scene, and a
      // stamp takes the picker's current icon (naming the layer for it, so the
      // tree reads "Check" rather than a dozen identical "Stamp"s).
      const placed: SceneNode = node.step
        ? { ...node, step: { ...node.step, number: nextStepNumber(doc.nodes) } }
        : node.stamp
          ? {
              ...node,
              stamp: { kind: s.stampKind },
              name: stampLabel(s.stampKind),
            }
          : node;
      const targetParent =
        parentId === undefined
          ? frameAt(
              doc,
              { x: node.x + node.width / 2, y: node.y + node.height / 2 },
              new Set([node.id])
            )
          : parentId;
      mutate((d) => {
        const nodes = { ...d.nodes, [node.id]: placed };
        let next: SceneDoc;
        const parent = targetParent ? nodes[targetParent] : undefined;
        if (targetParent && parent && isContainer(parent)) {
          nodes[targetParent] = {
            ...parent,
            children: [...parent.children, node.id],
          };
          next = { rootIds: d.rootIds, nodes };
        } else {
          next = { rootIds: [...d.rootIds, node.id], nodes };
        }
        // A spotlight dims the page frame's rect, so that rect must equal the
        // document extent — otherwise a stray root exports as an undimmed band
        // (the ADR 0019/0020 export-region trap). Sealing the page is therefore
        // part of adding one, in the same undo step. See lib/spotlight.ts.
        if (placed.spotlight) {
          const pageId = pageFrameId(next.rootIds, next.nodes);
          if (pageId) next = absorbRootsIntoPage(next, pageId);
        }
        return next;
      });
      set({ selectedIds: [node.id] });
    },

    updateNode: (id, patch, opts) =>
      mutate((d) => patchNode(d, id, patch), opts),

    updateNodes: (ids, patch, opts) =>
      mutate((d) => {
        let nodes = d.nodes;
        for (const id of ids) {
          const node = nodes[id];
          if (!node) continue;
          nodes = withNode(nodes, id, { ...node, ...patch } as SceneNode);
        }
        return nodes === d.nodes ? d : { rootIds: d.rootIds, nodes };
      }, opts),

    updateEach: (ids, patch, opts) =>
      mutate((d) => {
        let nodes = d.nodes;
        for (const id of ids) {
          const node = nodes[id];
          if (!node) continue;
          const p = patch(node);
          if (!p) continue;
          nodes = withNode(nodes, id, { ...node, ...p } as SceneNode);
        }
        return nodes === d.nodes ? d : { rootIds: d.rootIds, nodes };
      }, opts),

    moveNodes: (ids, dx, dy, opts) =>
      mutate((d) => {
        if (dx === 0 && dy === 0) return d;
        const deltas = new Map<string, Vec2>();
        for (const id of ids) deltas.set(id, { x: dx, y: dy });
        return translateBy(d, deltas);
      }, opts),

    placeNodes: (ids, at, opts) =>
      mutate((d) => {
        const deltas = new Map<string, Vec2>();
        for (const id of ids) {
          const node = d.nodes[id];
          if (!node) continue;
          const b = nodeBounds(node);
          deltas.set(id, {
            x: at.x === undefined ? 0 : at.x - b.x,
            y: at.y === undefined ? 0 : at.y - b.y,
          });
        }
        return translateBy(d, deltas);
      }, opts),

    resizeNode: (id, handle, pointer, start, rotation, opts) =>
      mutate((d) => {
        const node = d.nodes[id];
        if (!node) return d;
        const frame = resizeFrame(start, rotation, handle, pointer, {
          keepAspect: opts?.keepAspect ?? false,
          fromCenter: opts?.fromCenter ?? false,
        });
        return patchNode(d, id, frame);
      }, opts),

    rotateNode: (id, rotation, opts) =>
      mutate((d) => patchNode(d, id, { rotation }), opts),

    setText: (id, text, opts) =>
      mutate((d) => {
        const node = d.nodes[id];
        if (!node || node.type !== "text") return d;
        return patchNode(d, id, { text } as Partial<SceneNode>);
      }, opts),

    removeNodes: (ids) => {
      const s = get();
      const doc = currentDoc(s);
      const doomed = new Set<string>();
      for (const id of ids) {
        if (!doc.nodes[id]) continue;
        doomed.add(id);
        for (const d of descendantIds(doc, id)) doomed.add(d);
      }
      if (doomed.size === 0) return;
      mutate((d) => {
        const nodes: Record<string, SceneNode> = {};
        for (const nid of Object.keys(d.nodes)) {
          if (doomed.has(nid)) continue;
          const node = d.nodes[nid]!;
          nodes[nid] =
            isContainer(node) && node.children.some((c) => doomed.has(c))
              ? {
                  ...node,
                  children: node.children.filter((c) => !doomed.has(c)),
                }
              : node;
        }
        return { rootIds: d.rootIds.filter((r) => !doomed.has(r)), nodes };
      });
      set((st) => ({
        selectedIds: st.selectedIds.filter((x) => !doomed.has(x)),
      }));
    },

    removeSelected: () => {
      const ids = get().selectedIds;
      if (ids.length) get().removeNodes(ids);
    },

    duplicateNodes: (ids, offset = DUP_OFFSET) => {
      const doc = currentDoc(get());
      const tops = topLevelSelection(doc, ids);
      if (tops.length === 0) return;
      // Pre-clone once (ids draw from the global counter) so they're stable.
      const clones = tops.map((id) => {
        const out: Record<string, SceneNode> = {};
        const cloneId = cloneInto(doc.nodes, id, out);
        const root = out[cloneId]!;
        out[cloneId] = { ...root, x: root.x + offset, y: root.y + offset };
        return { originalId: id, cloneId, out, parentId: parentOf(doc, id) };
      });
      mutate((d) => {
        let nodes = { ...d.nodes };
        let rootIds = d.rootIds;
        for (const c of clones) {
          nodes = { ...nodes, ...c.out };
          if (c.parentId) {
            const parent = nodes[c.parentId];
            if (parent && isContainer(parent)) {
              nodes[c.parentId] = {
                ...parent,
                children: insertAfter(parent.children, c.originalId, c.cloneId),
              };
            }
          } else {
            rootIds = insertAfter(rootIds, c.originalId, c.cloneId);
          }
        }
        return { rootIds, nodes };
      });
      set({ selectedIds: clones.map((c) => c.cloneId) });
    },

    copyNodes: (ids) => {
      const tops = topLevelSelection(currentDoc(get()), ids);
      if (tops.length === 0) return;
      set({ clipboard: cloneFragment(get().nodes, tops) });
    },

    pasteClipboard: (at) => {
      const frag = get().clipboard;
      if (!frag || frag.rootIds.length === 0) return;
      const fresh = recloneFragment(frag);
      const roots = fresh.rootIds
        .map((id) => fresh.nodes[id])
        .filter((n): n is SceneNode => !!n);
      const bounds = unionBounds(roots);
      const dx = at && bounds ? at.x - bounds.x : DUP_OFFSET;
      const dy = at && bounds ? at.y - bounds.y : DUP_OFFSET;
      for (const id of fresh.rootIds) {
        const n = fresh.nodes[id]!;
        fresh.nodes[id] = { ...n, x: n.x + dx, y: n.y + dy };
      }
      mutate((d) => {
        const nodes = { ...d.nodes, ...fresh.nodes };
        const rootIds = [...d.rootIds, ...fresh.rootIds];
        return { rootIds, nodes };
      });
      set({ selectedIds: fresh.rootIds });
    },

    bringToFront: (ids) => zorder(ids, "front"),
    bringForward: (ids) => zorder(ids, "forward"),
    sendBackward: (ids) => zorder(ids, "backward"),
    sendToBack: (ids) => zorder(ids, "back"),

    openContextMenu: (cm) => set({ contextMenu: cm }),
    closeContextMenu: () =>
      set((s) => (s.contextMenu ? { contextMenu: null } : {})),
    openColorEditor: (target, x, y, peers = []) =>
      set((s) => {
        // Editing a gradient fill lights up the on-canvas gradient handles.
        let gradientEditFillId: string | null = null;
        if (target.kind === "fill") {
          const fill = currentDoc(s).nodes[target.nodeId]?.fills.find(
            (f) => f.id === target.fillId
          );
          if (fill?.type === "gradient") gradientEditFillId = target.fillId;
        }
        return { colorEditor: { target, peers, x, y }, gradientEditFillId };
      }),
    closeColorEditor: () =>
      set((s) =>
        s.colorEditor || s.gradientEditFillId
          ? { colorEditor: null, gradientEditFillId: null }
          : {}
      ),
    setCanvasSize: (width, height) =>
      set((s) =>
        s.canvasSize.width === width && s.canvasSize.height === height
          ? {}
          : { canvasSize: { width, height } }
      ),
    fitView: () => {
      const { width, height } = get().canvasSize;
      if (width > 1 && height > 1) get().zoomToFit(width, height);
    },
    zoomToSelection: (vw, vh) =>
      set((s) => {
        if (vw < 2 || vh < 2) return {};
        const sel = resolveNodes(s.nodes, s.selectedIds);
        const b = unionBounds(sel);
        if (!b || b.width === 0 || b.height === 0) return {};
        const pad = 0.8;
        const zoom = clampZoom(
          Math.min((vw * pad) / b.width, (vh * pad) / b.height)
        );
        return {
          viewport: {
            zoom,
            panX: vw / 2 - (b.x + b.width / 2) * zoom,
            panY: vh / 2 - (b.y + b.height / 2) * zoom,
          },
        };
      }),
    fitSelection: () => {
      const { width, height } = get().canvasSize;
      if (width > 1 && height > 1) get().zoomToSelection(width, height);
    },
    centerView: () => {
      const { width: vw, height: vh } = get().canvasSize;
      if (vw < 2 || vh < 2) return;
      set((s) => {
        const b = unionBounds(resolveNodes(s.nodes, s.rootIds));
        if (!b) return {};
        const { zoom } = s.viewport;
        return {
          viewport: {
            zoom,
            panX: vw / 2 - (b.x + b.width / 2) * zoom,
            panY: vh / 2 - (b.y + b.height / 2) * zoom,
          },
        };
      });
    },

    setShowGrid: (show) =>
      set((s) => (s.showGrid === show ? {} : { showGrid: show })),
    toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),

    toggleSection: (id) =>
      set((s) => ({
        sectionsOpen: {
          ...s.sectionsOpen,
          [id]: !(s.sectionsOpen[id] ?? true),
        },
      })),
    setInspectorDock: (mode, side) =>
      set((s) =>
        s.inspectorDock[mode] === side
          ? { dockPreview: null }
          : {
              inspectorDock: { ...s.inspectorDock, [mode]: side },
              // A completed dock/undock always ends the drag that caused it.
              dockPreview: null,
            }
      ),
    setDockPreview: (side) =>
      set((s) => (s.dockPreview === side ? {} : { dockPreview: side })),
    setSectionOpen: (id, open) =>
      set((s) =>
        (s.sectionsOpen[id] ?? true) === open
          ? {}
          : { sectionsOpen: { ...s.sectionsOpen, [id]: open } }
      ),
    setInspectorTab: (tab) =>
      set((s) => (s.inspectorTab === tab ? {} : { inspectorTab: tab })),
    setPanelWidth: (px) =>
      set((s) => {
        const next = clampPanelWidth(px);
        return s.panelWidth === next ? {} : { panelWidth: next };
      }),
    setShowRulers: (show) =>
      set((s) => (s.showRulers === show ? {} : { showRulers: show })),
    toggleRulers: () => set((s) => ({ showRulers: !s.showRulers })),
    setSnapEnabled: (enabled) =>
      set((s) => (s.snapEnabled === enabled ? {} : { snapEnabled: enabled })),
    toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
    setCursor: (cursor) => set({ cursor }),
    setGuides: (guides) =>
      set((s) =>
        s.guides.length === 0 && guides.length === 0 ? {} : { guides }
      ),
    setTransformHud: (hud) =>
      set((s) =>
        s.transformHud === null && hud === null ? {} : { transformHud: hud }
      ),
    setActiveGesture: (kind) =>
      set((s) => (s.activeGesture === kind ? {} : { activeGesture: kind })),
    setGradientEditFill: (fillId) =>
      set((s) =>
        s.gradientEditFillId === fillId ? {} : { gradientEditFillId: fillId }
      ),
    setPen: (pen) => set({ pen }),
    setTempPan: (on) => set((s) => (s.tempPan === on ? {} : { tempPan: on })),
    setHelpOpen: (open) =>
      set((s) => (s.helpOpen === open ? {} : { helpOpen: open })),
    toggleHelp: () => set((s) => ({ helpOpen: !s.helpOpen })),
    requestExport: () => set((s) => ({ exportRequest: s.exportRequest + 1 })),

    setVisible: (id, visible) => mutate((d) => patchNode(d, id, { visible })),
    setLocked: (id, locked) => mutate((d) => patchNode(d, id, { locked })),
    renameNode: (id, name) => mutate((d) => patchNode(d, id, { name })),
    requestRename: (id) => set({ renamingId: id }),
    clearRename: () =>
      set((s) => (s.renamingId === null ? {} : { renamingId: null })),

    reorderNode: (dragId, targetId, edge) => {
      const s = get();
      const doc = currentDoc(s);
      if (dragId === targetId) return;
      // No-op if the drag would land inside its own subtree.
      if (descendantIds(doc, dragId).includes(targetId)) return;
      const fromParent = parentOf(doc, dragId);
      const toParent = parentOf(doc, targetId);
      mutate((d) => {
        const removeFrom = (ids: readonly string[]) =>
          ids.filter((x) => x !== dragId);
        const insertInto = (ids: readonly string[]) => {
          const base = removeFrom(ids);
          const idx = base.indexOf(targetId);
          if (idx < 0) return [...base, dragId];
          const at = edge === "before" ? idx : idx + 1;
          return [...base.slice(0, at), dragId, ...base.slice(at)];
        };
        const nodes = { ...d.nodes };
        let rootIds = d.rootIds;
        const applyParent = (
          parentId: string | null,
          fn: (ids: readonly string[]) => string[]
        ) => {
          if (parentId) {
            const parent = nodes[parentId];
            if (parent && isContainer(parent)) {
              nodes[parentId] = { ...parent, children: fn(parent.children) };
            }
          } else {
            rootIds = fn(rootIds);
          }
        };
        if (fromParent === toParent) {
          applyParent(toParent, insertInto);
        } else {
          applyParent(fromParent, removeFrom);
          applyParent(toParent, insertInto);
        }
        return { rootIds, nodes };
      });
    },

    align: (mode) => {
      const s = get();
      const doc = currentDoc(s);
      const nodes = resolveNodes(doc.nodes, s.selectedIds).filter(
        (n) => !n.locked
      );
      if (nodes.length === 0) return;
      const frame =
        nodes.length === 1
          ? alignFrameForSingle(doc, nodes[0]!)
          : unionBounds(nodes);
      if (!frame) return;
      mutate((d) => {
        let next = d;
        if (mode === "distribute-h" || mode === "distribute-v") {
          next = distribute(d, nodes, mode);
        } else {
          for (const node of nodes) {
            const b = rotatedAABB(node);
            const patch = alignPatch(mode, b, frame, node);
            if (patch) next = patchNode(next, node.id, patch);
          }
        }
        return next;
      });
    },

    group: () => {
      const s = get();
      const doc = currentDoc(s);
      const tops = sortByPaintOrder(doc, topLevelSelection(doc, s.selectedIds));
      if (tops.length === 0) return;
      const bounds = unionBounds(resolveNodes(doc.nodes, tops));
      if (!bounds) return;
      const topSet = new Set(tops);
      // Keep the group in place under a shared parent; mixed parents → root.
      const parents = new Set(tops.map((id) => parentOf(doc, id)));
      const targetParent = parents.size === 1 ? [...parents][0]! : null;
      const frame = makeFrame(bounds, { name: "Group", clipContent: false });
      mutate((d) => {
        const origTarget = childIds(d, targetParent); // pre-removal order
        const nodes: Record<string, SceneNode> = {
          ...d.nodes,
          [frame.id]: { ...frame, children: tops },
        };
        // Detach the members from every container (not the new group) + root.
        for (const nid of Object.keys(nodes)) {
          if (nid === frame.id) continue;
          const n = nodes[nid]!;
          if (isContainer(n) && n.children.some((c) => topSet.has(c))) {
            nodes[nid] = {
              ...n,
              children: n.children.filter((c) => !topSet.has(c)),
            };
          }
        }
        let rootIds = d.rootIds.filter((id) => !topSet.has(id));
        // Insert the group where the frontmost member sat in the target list.
        let frontIdx = -1;
        for (let i = 0; i < origTarget.length; i++) {
          if (topSet.has(origTarget[i]!)) frontIdx = i;
        }
        const insertAt =
          frontIdx < 0
            ? Infinity
            : origTarget.slice(0, frontIdx).filter((id) => !topSet.has(id))
                .length;
        if (targetParent) {
          const p = nodes[targetParent];
          if (p && isContainer(p)) {
            const kept = [...p.children];
            kept.splice(Math.min(insertAt, kept.length), 0, frame.id);
            nodes[targetParent] = { ...p, children: kept };
          } else {
            rootIds = [...rootIds, frame.id];
          }
        } else {
          rootIds.splice(Math.min(insertAt, rootIds.length), 0, frame.id);
        }
        return { rootIds, nodes };
      });
      set({ selectedIds: [frame.id] });
    },

    ungroup: () => {
      const s = get();
      const doc = currentDoc(s);
      const frames = s.selectedIds.filter((id) => {
        const n = doc.nodes[id];
        return !!n && isContainer(n);
      });
      if (frames.length === 0) return;
      const freed: string[] = [];
      mutate((d) => {
        const nodes = { ...d.nodes };
        let rootIds = [...d.rootIds];
        const splice = (list: string[], frameId: string, kids: string[]) => {
          const idx = list.indexOf(frameId);
          return idx < 0
            ? list
            : [...list.slice(0, idx), ...kids, ...list.slice(idx + 1)];
        };
        for (const frameId of frames) {
          const frame = nodes[frameId];
          if (!frame || !isContainer(frame)) continue;
          const kids = frame.children;
          freed.push(...kids);
          const parent = parentOf({ rootIds, nodes }, frameId);
          if (parent) {
            const p = nodes[parent];
            if (p && isContainer(p)) {
              nodes[parent] = {
                ...p,
                children: splice([...p.children], frameId, kids),
              };
            }
          } else {
            rootIds = splice(rootIds, frameId, kids);
          }
          delete nodes[frameId];
        }
        return { rootIds, nodes };
      });
      if (freed.length) set({ selectedIds: freed });
    },

    addFills: (ids) =>
      appendEntries(ids, "fills", () => makeSolidPaint("#d9d9d9", 1)),
    updateFills: (refs, patch) => patchEntries(refs, "fills", patch),
    removeFills: (refs) => dropEntries(refs, "fills"),
    addFill: (id) => get().addFills([id]),
    updateFill: (id, fillId, patch) =>
      get().updateFills([{ nodeId: id, entryId: fillId }], patch),
    removeFill: (id, fillId) =>
      get().removeFills([{ nodeId: id, entryId: fillId }]),

    addStrokes: (ids) =>
      appendEntries(ids, "strokes", () => makeStroke("#000000", 1)),
    updateStrokes: (refs, patch) => patchEntries(refs, "strokes", patch),
    removeStrokes: (refs) => dropEntries(refs, "strokes"),
    addStroke: (id) => get().addStrokes([id]),
    updateStroke: (id, strokeId, patch) =>
      get().updateStrokes([{ nodeId: id, entryId: strokeId }], patch),
    removeStroke: (id, strokeId) =>
      get().removeStrokes([{ nodeId: id, entryId: strokeId }]),

    addEffects: (ids, type = "drop-shadow") =>
      appendEntries(ids, "effects", () => ({ ...makeShadow(), type })),
    updateEffects: (refs, patch) => patchEntries(refs, "effects", patch),
    removeEffects: (refs) => dropEntries(refs, "effects"),
    addEffect: (id, type) => get().addEffects([id], type),
    updateEffect: (id, effectId, patch) =>
      get().updateEffects([{ nodeId: id, entryId: effectId }], patch),
    removeEffect: (id, effectId) =>
      get().removeEffects([{ nodeId: id, entryId: effectId }]),

    // ----- crop -----
    // Enter/leave go through setTool so the tool and the session can never
    // disagree (the toolbar, the `C` keybind and the crop bar all land here).
    beginCrop: () => get().setTool("crop"),
    cancelCrop: () => {
      if (get().cropSession) get().setTool("select");
    },

    setCropRect: (rect) =>
      set((s) =>
        s.cropSession ? { cropSession: { ...s.cropSession, rect } } : {}
      ),

    setCropAspect: (aspect) =>
      set((s) => {
        if (!s.cropSession) return {};
        const rect =
          aspect === null
            ? s.cropSession.rect
            : applyCropAspect(s.cropSession.rect, aspect);
        return { cropSession: { ...s.cropSession, aspect, rect } };
      }),

    resetCrop: () =>
      set((s) =>
        s.cropSession
          ? {
              cropSession: {
                ...s.cropSession,
                rect: s.cropSession.original,
                aspect: null,
              },
            }
          : {}
      ),

    commitCrop: () => {
      const s = get();
      const session = s.cropSession;
      if (!session) return;
      const node = s.nodes[session.nodeId];
      const rect = roundCrop(session.rect);
      // Resizing the page frame *is* the crop — children keep their absolute
      // coords and `clipContent` trims them, so no pixels are discarded and
      // undo restores the full page (see lib/crop.ts). Absorbing the other
      // roots in the same step is what makes the export follow the crop, and
      // `clipContent` is forced on so the live canvas shows the same trim the
      // export will apply (the two-renderer invariant).
      if (node && cropChanges(node, rect)) {
        mutate((d) =>
          absorbRootsIntoPage(
            patchNode(d, session.nodeId, { ...rect, clipContent: true }),
            session.nodeId
          )
        );
      }
      set({
        tool: "select",
        cropSession: null,
        // Select the page so the new bounds are visible as selection chrome.
        selectedIds: node ? [session.nodeId] : [],
      });
    },

    // ----- page backdrop (ADR 0020) -----
    // Every action here resolves the same two anchors — the page frame and the
    // capture inside it — and stays inert without both, exactly as crop does
    // when `pageFrameId` finds no page.
    setPagePadding: (padding) => {
      const t = pageTargets(get());
      if (!t) return;
      mutate((d) => applyPagePadding(d, t.pageId, t.content.rect, padding));
    },

    applyBackdrop: (presetId) => {
      const preset = backdropPreset(presetId);
      const t = pageTargets(get());
      if (!preset || !t) return;
      const fills = preset.build();
      const page = get().nodes[t.pageId];
      // A backdrop on a page with no margin is invisible — the capture covers
      // the page exactly — so opening a default margin (and rounding the
      // capture) is part of *this* edit rather than a second thing to discover.
      const needsMargin =
        fills.length > 0 && !!page && pagePadding(page, t.content.rect) === 0;
      mutate((d) => {
        let next = applyPageBackdrop(d, t.pageId, fills);
        if (needsMargin) {
          next = applyPagePadding(
            next,
            t.pageId,
            t.content.rect,
            DEFAULT_PAGE_PADDING
          );
          next = applyContentRadius(next, t.content.id, DEFAULT_CONTENT_RADIUS);
        }
        return next;
      });
    },

    setContentRadius: (radius) => {
      const t = pageTargets(get());
      if (!t) return;
      mutate((d) => applyContentRadius(d, t.content.id, radius));
    },

    setContentShadow: (on) => {
      const t = pageTargets(get());
      if (!t) return;
      mutate((d) => applyContentShadow(d, t.content.id, on));
    },

    // ----- window chrome (ADR 0022) -----
    // Same two anchors as the backdrop actions, and the same inert-without-both
    // behaviour. `applyWindowChrome` owns the page-resize half so the bar can
    // never end up clipped by the page it lives in.
    applyChrome: (presetId) => {
      const preset = chromePreset(presetId);
      const t = pageTargets(get());
      if (!preset || !t) return;
      const content = get().nodes[t.content.id];
      if (!content || !canCarryChrome(content)) return;
      // Carry the typed title across a style switch — it's content, not style.
      const chrome = makeChrome(preset, content.chrome?.title ?? "");
      // A square-cornered window is the one thing that makes chrome look
      // broken rather than plain, so rounding is part of *this* edit — the
      // same reasoning that has `applyBackdrop` open a margin (ADR 0020).
      const needsRadius =
        !!chrome && !content.chrome && content.cornerRadius === 0;
      mutate((d) => {
        const next = applyWindowChrome(d, t.pageId, t.content.id, chrome);
        return needsRadius
          ? applyContentRadius(next, t.content.id, DEFAULT_CHROME_RADIUS)
          : next;
      });
    },

    setChromeTitle: (title) => {
      const t = pageTargets(get());
      const content = t ? get().nodes[t.content.id] : null;
      if (!t || !content?.chrome) return;
      mutate((d) =>
        applyWindowChrome(d, t.pageId, t.content.id, {
          ...content.chrome!,
          title,
        })
      );
    },

    setChromeHeight: (height) => {
      const t = pageTargets(get());
      const content = t ? get().nodes[t.content.id] : null;
      if (!t || !content?.chrome) return;
      mutate((d) =>
        applyWindowChrome(d, t.pageId, t.content.id, {
          ...content.chrome!,
          height: clampChromeHeight(height),
        })
      );
    },

    setDocName: (name) => set({ docName: name || "Untitled" }),

    setZoom: (zoom, anchor) =>
      set((s) => {
        const z = clampZoom(zoom);
        if (!anchor) return { viewport: { ...s.viewport, zoom: z } };
        // Keep the scene point under (anchor.x, anchor.y) stationary.
        const { panX, panY, zoom: z0 } = s.viewport;
        const sceneX = (anchor.x - panX) / z0;
        const sceneY = (anchor.y - panY) / z0;
        return {
          viewport: {
            zoom: z,
            panX: anchor.x - sceneX * z,
            panY: anchor.y - sceneY * z,
          },
        };
      }),
    zoomIn: () =>
      set((s) => ({
        viewport: { ...s.viewport, zoom: nextZoom(s.viewport.zoom, 1) },
      })),
    zoomOut: () =>
      set((s) => ({
        viewport: { ...s.viewport, zoom: nextZoom(s.viewport.zoom, -1) },
      })),
    resetZoom: () => set((s) => ({ viewport: { ...s.viewport, zoom: 1 } })),
    zoomToFit: (vw, vh) =>
      set((s) => {
        const all = resolveNodes(s.nodes, s.rootIds);
        const b = unionBounds(all);
        if (!b || b.width === 0 || b.height === 0) {
          return { viewport: { zoom: 1, panX: vw / 2, panY: vh / 2 } };
        }
        const pad = 0.85;
        const zoom = clampZoom(
          Math.min((vw * pad) / b.width, (vh * pad) / b.height)
        );
        return {
          viewport: {
            zoom,
            panX: vw / 2 - (b.x + b.width / 2) * zoom,
            panY: vh / 2 - (b.y + b.height / 2) * zoom,
          },
        };
      }),
    panBy: (dx, dy) =>
      set((s) => ({
        viewport: {
          ...s.viewport,
          panX: s.viewport.panX + dx,
          panY: s.viewport.panY + dy,
        },
      })),
    setPan: (panX, panY) =>
      set((s) => ({ viewport: { ...s.viewport, panX, panY } })),

    pushHistory: () =>
      set((s) => ({ past: pushPast(s.past, currentDoc(s)), future: [] })),

    beginHistory: () =>
      set((s) =>
        // Arm the lazy snapshot only when entering the outermost transaction.
        s.txnDepth === 0
          ? { txnDepth: 1, txnPendingSnapshot: true }
          : { txnDepth: s.txnDepth + 1 }
      ),
    endHistory: () =>
      set((s) => {
        const depth = Math.max(0, s.txnDepth - 1);
        return depth === 0
          ? { txnDepth: 0, txnPendingSnapshot: false }
          : { txnDepth: depth };
      }),

    undo: () =>
      set((s) => {
        const prev = s.past[s.past.length - 1];
        if (!prev) return {};
        const liveIds = new Set(Object.keys(prev.nodes));
        return {
          past: s.past.slice(0, -1),
          future: [currentDoc(s), ...s.future],
          rootIds: prev.rootIds,
          nodes: prev.nodes,
          selectedIds: s.selectedIds.filter((id) => liveIds.has(id)),
          docStatus: "edited",
        };
      }),
    redo: () =>
      set((s) => {
        const next = s.future[0];
        if (!next) return {};
        const liveIds = new Set(Object.keys(next.nodes));
        return {
          future: s.future.slice(1),
          past: pushPast(s.past, currentDoc(s)),
          rootIds: next.rootIds,
          nodes: next.nodes,
          selectedIds: s.selectedIds.filter((id) => liveIds.has(id)),
          docStatus: "edited",
        };
      }),
  };
});

// --------- align helpers (module-pure) ----------

function alignFrameForSingle(doc: SceneDoc, node: SceneNode): Rect | null {
  const parentId = parentOf(doc, node.id);
  if (parentId) {
    const parent = doc.nodes[parentId];
    if (parent) return nodeBounds(parent);
  }
  return null;
}

function alignPatch(
  mode: AlignMode,
  bounds: Rect,
  frame: Rect,
  node: SceneNode
): Partial<SceneNode> | null {
  // Shift the node so its rotated AABB aligns; preserves the frame offset.
  const offsetX = node.x - bounds.x;
  const offsetY = node.y - bounds.y;
  switch (mode) {
    case "left":
      return { x: frame.x + offsetX };
    case "center-h":
      return { x: frame.x + (frame.width - bounds.width) / 2 + offsetX };
    case "right":
      return { x: frame.x + frame.width - bounds.width + offsetX };
    case "top":
      return { y: frame.y + offsetY };
    case "center-v":
      return { y: frame.y + (frame.height - bounds.height) / 2 + offsetY };
    case "bottom":
      return { y: frame.y + frame.height - bounds.height + offsetY };
    case "distribute-h":
    case "distribute-v":
      return null;
  }
}

function distribute(
  doc: SceneDoc,
  nodes: readonly SceneNode[],
  mode: "distribute-h" | "distribute-v"
): SceneDoc {
  if (nodes.length < 3) return doc;
  const horizontal = mode === "distribute-h";
  const measured = nodes
    .map((n) => ({ node: n, b: rotatedAABB(n) }))
    .sort((a, b) => (horizontal ? a.b.x - b.b.x : a.b.y - b.b.y));
  const first = measured[0]!;
  const last = measured[measured.length - 1]!;
  const span = horizontal
    ? last.b.x + last.b.width - first.b.x
    : last.b.y + last.b.height - first.b.y;
  const totalSize = measured.reduce(
    (sum, m) => sum + (horizontal ? m.b.width : m.b.height),
    0
  );
  const gap = (span - totalSize) / (measured.length - 1);
  let cursor = horizontal ? first.b.x : first.b.y;
  let next = doc;
  for (const m of measured) {
    const offset = horizontal ? m.node.x - m.b.x : m.node.y - m.b.y;
    const patch: Partial<SceneNode> = horizontal
      ? { x: cursor + offset }
      : { y: cursor + offset };
    next = {
      rootIds: next.rootIds,
      nodes: withNode(next.nodes, m.node.id, {
        ...next.nodes[m.node.id]!,
        ...patch,
      } as SceneNode),
    };
    cursor += (horizontal ? m.b.width : m.b.height) + gap;
  }
  return next;
}

/** Clone a node subtree into `out` with fresh ids (node + paints), returning
 *  the new root id. Source-map agnostic, so it powers duplicate and paste. */
function cloneInto(
  src: Record<string, SceneNode>,
  id: string,
  out: Record<string, SceneNode>
): string {
  const node = src[id];
  if (!node) return id;
  const newId = nextNodeId();
  const fills = node.fills.map((f) => ({ ...f, id: nextNodeId("fill") }));
  const strokes = node.strokes.map((s) => ({ ...s, id: nextNodeId("stroke") }));
  const effects = node.effects.map((e) => ({ ...e, id: nextNodeId("fx") }));
  const clone: SceneNode =
    node.type === "frame"
      ? {
          ...node,
          id: newId,
          fills,
          strokes,
          effects,
          children: node.children.map((c) => cloneInto(src, c, out)),
        }
      : { ...node, id: newId, fills, strokes, effects };
  out[newId] = clone;
  return newId;
}

function cloneFragment(
  src: Record<string, SceneNode>,
  ids: readonly string[]
): ClipboardFragment {
  const nodes: Record<string, SceneNode> = {};
  const rootIds = ids
    .filter((id) => src[id])
    .map((id) => cloneInto(src, id, nodes));
  return { rootIds, nodes };
}

function recloneFragment(frag: ClipboardFragment): ClipboardFragment {
  const nodes: Record<string, SceneNode> = {};
  const rootIds = frag.rootIds.map((id) => cloneInto(frag.nodes, id, nodes));
  return { rootIds, nodes };
}

function insertAfter(
  ids: readonly string[],
  anchor: string,
  value: string
): string[] {
  const arr = [...ids];
  const at = arr.indexOf(anchor);
  arr.splice(at < 0 ? arr.length : at + 1, 0, value);
  return arr;
}

/** Drop selected ids whose ancestor is also selected (a frame + its child
 *  collapse to the frame). Order + dedupe preserved. */
function topLevelSelection(doc: SceneDoc, ids: readonly string[]): string[] {
  const descendants = new Set<string>();
  for (const id of ids)
    for (const d of descendantIds(doc, id)) descendants.add(d);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!doc.nodes[id] || descendants.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Back-to-front paint rank for every node (DFS of roots, descending into
 *  frames). Used to order a multi-parent selection inside a new group. */
function paintOrderRank(doc: SceneDoc): Map<string, number> {
  const rank = new Map<string, number>();
  let i = 0;
  const walk = (ids: readonly string[]): void => {
    for (const id of ids) {
      const node = doc.nodes[id];
      if (!node) continue;
      rank.set(id, i++);
      if (isContainer(node)) walk(node.children);
    }
  };
  walk(doc.rootIds);
  return rank;
}

/** Sort ids back-to-front by paint order (stable for same-parent siblings). */
function sortByPaintOrder(doc: SceneDoc, ids: readonly string[]): string[] {
  const rank = paintOrderRank(doc);
  return [...ids].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
}

function groupSelectedByParent(
  doc: SceneDoc,
  ids: readonly string[]
): Map<string | null, Set<string>> {
  const groups = new Map<string | null, Set<string>>();
  for (const id of ids) {
    if (!doc.nodes[id]) continue;
    const parent = parentOf(doc, id);
    const set = groups.get(parent) ?? new Set<string>();
    set.add(id);
    groups.set(parent, set);
  }
  return groups;
}

/** Reorder one parent's child array for a z-order action. `front`/`back` move
 *  the whole selection to an end; `forward`/`backward` nudge by one without
 *  letting selected siblings cross each other. */
function applyZOrder(
  arr: readonly string[],
  selected: ReadonlySet<string>,
  mode: ZMode
): string[] {
  if (mode === "front") {
    return [
      ...arr.filter((x) => !selected.has(x)),
      ...arr.filter((x) => selected.has(x)),
    ];
  }
  if (mode === "back") {
    return [
      ...arr.filter((x) => selected.has(x)),
      ...arr.filter((x) => !selected.has(x)),
    ];
  }
  const next = [...arr];
  if (mode === "forward") {
    for (let i = next.length - 2; i >= 0; i--) {
      if (selected.has(next[i]!) && !selected.has(next[i + 1]!)) {
        [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
      }
    }
  } else {
    for (let i = 1; i < next.length; i++) {
      if (selected.has(next[i]!) && !selected.has(next[i - 1]!)) {
        [next[i], next[i - 1]] = [next[i - 1]!, next[i]!];
      }
    }
  }
  return next;
}

/**
 * Derived-read API for the store. Components select through these instead of
 * touching the flat node map / page tree directly, so the tree traversal and
 * id→node resolution stay encapsulated. (`canUndo`/`canRedo` are trivial —
 * read `past.length`/`future.length` inline at the call site.)
 */
export const editorSelectors = {
  selectedNodes(s: EditorState): SceneNode[] {
    return resolveNodes(s.nodes, s.selectedIds);
  },
  parentOf(s: EditorState, id: string): string | null {
    return parentOf(currentDoc(s), id);
  },
  childIds(s: EditorState, parentId: string | null): readonly string[] {
    return childIds(currentDoc(s), parentId);
  },
};
