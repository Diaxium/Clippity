import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  angleFromCenter,
  calloutTailFromLocal,
  clampZoom,
  drawRect,
  hitTestNode,
  normalizeRect,
  rectsIntersect,
  rotatedAABB,
  sceneToFrameLocal,
  unionBounds,
  type ResizeHandle,
} from "../geometry";
import {
  createNodeForTool,
  isContainer,
  isLineLike,
  makeImage,
  makePath,
  makeText,
  pathGeometry,
  type GradientPaint,
  type Rect,
  type SceneNode,
  type Vec2,
} from "../types";
import { useEditorStore, type Viewport } from "../state/editorStore";
import {
  applyGradientHandle,
  gradientGeometry,
  moveFreeformPoint,
  moveMeshPoint,
  type GradientGeometry,
  type GradientHandle,
} from "../lib/paint";
import {
  alignmentGuides,
  buildSnapLines,
  excludeSet,
  snapMove,
  snapPoint,
  SNAP_PX,
  type Guide,
  type SnapLine,
} from "../snapping";
import {
  cropAspectRatio,
  moveCrop,
  pointInCrop,
  resizeCrop,
} from "../lib/crop";
import { TOOL_BY_ID } from "../tools";
import { CanvasGrid } from "./CanvasGrid";
import { CropOverlay } from "./CropOverlay";
import { CanvasGuides } from "./CanvasGuides";
import { CanvasHintBar } from "./CanvasHintBar";
import { CanvasRulers } from "./CanvasRulers";
import { CanvasZoomControls } from "./CanvasZoomControls";
import { PenOverlay } from "./PenOverlay";
import { FloatingToolbar } from "./FloatingToolbar";
import { ObjectLabel } from "./ObjectLabel";
import { SceneNodeView } from "./SceneNodeView";
import { SelectionOverlay } from "./SelectionOverlay";
import { SelectionShadow } from "./SelectionShadow";
import { TransformHud } from "./TransformHud";

const DRAG_THRESHOLD = 3;
const ROTATE_SNAP = 15;

type Gesture =
  | { kind: "pan"; lastX: number; lastY: number }
  | { kind: "marquee"; start: Vec2 }
  | { kind: "draw"; start: Vec2; created: boolean; id: string | null }
  | { kind: "pencil"; points: Vec2[]; id: string | null }
  | {
      kind: "move";
      origin: Vec2;
      start: Rect | null;
      applied: Vec2;
      moved: boolean;
      lines: SnapLine[];
    }
  | {
      kind: "resize";
      id: string;
      handle: ResizeHandle;
      start: Rect;
      rotation: number;
      lines: SnapLine[];
    }
  | { kind: "rotate"; id: string; center: Vec2 }
  | {
      kind: "crop";
      /** Edge/corner being dragged, or null when the whole window is moving. */
      handle: ResizeHandle | null;
      start: Rect;
      origin: Vec2;
    }
  | {
      kind: "endpoint";
      id: string;
      which: "a" | "b";
      ax: number;
      ay: number;
      bx: number;
      by: number;
    }
  | {
      kind: "gradient";
      id: string;
      fillId: string;
      which: GradientHandle | "point" | "mesh";
      /** Freeform color-point id (`point`) or mesh node index as a string
       *  (`mesh`). */
      pointId?: string;
      gradient: GradientPaint;
      geo: GradientGeometry;
    }
  | { kind: "tail"; id: string };

/** Front-to-back pick. `deep` descends into frames (double-click); otherwise a
 *  hit inside a frame selects the frame itself. Skips hidden/locked subtrees. */
export function pickNode(
  nodes: Record<string, SceneNode>,
  ids: readonly string[],
  point: Vec2,
  tolerance: number,
  deep: boolean
): string | null {
  for (let i = ids.length - 1; i >= 0; i--) {
    const node = nodes[ids[i]!];
    if (!node || !node.visible || node.locked) continue;
    if (deep && isContainer(node)) {
      const child = pickNode(nodes, node.children, point, tolerance, true);
      if (child) return child;
      if (hitTestNode(node, point, tolerance)) return node.id;
    } else if (hitTestNode(node, point, tolerance)) {
      return node.id;
    }
  }
  return null;
}

/**
 * The interactive canvas: an infinite, pannable/zoomable surface that renders
 * the active page and owns every pointer gesture (pan, marquee, draw, move,
 * resize, rotate, line-endpoint) plus wheel zoom/pan and inline text editing.
 * All scene mutations go through the store; picking uses the geometry engine
 * rather than DOM hit-testing so frame nesting and tolerances stay correct.
 */
export function EditorCanvas() {
  const nodes = useEditorStore((s) => s.nodes);
  const rootIds = useEditorStore((s) => s.rootIds);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const tool = useEditorStore((s) => s.tool);
  const viewport = useEditorStore((s) => s.viewport);
  const editingTextId = useEditorStore((s) => s.editingTextId);
  const sourceId = useEditorStore((s) => s.sourceId);
  const showGrid = useEditorStore((s) => s.showGrid);
  const showRulers = useEditorStore((s) => s.showRulers);
  const gradientEditFillId = useEditorStore((s) => s.gradientEditFillId);
  // Temporary pan while Space is held — driven by the central keybind system
  // (useEditorKeybinds), read here so the pointer + cursor logic can grab-pan
  // without disturbing the active tool.
  const tempPan = useEditorStore((s) => s.tempPan);

  const hostRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const moveAltRef = useRef(false);
  const pendingImagePoint = useRef<Vec2 | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Track the viewport size for ruler ticks + zoom-to-fit anchoring.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const sync = (w: number, h: number) => {
      setSize({ width: w, height: h });
      useEditorStore.getState().setCanvasSize(w, h);
    };
    const ro = new ResizeObserver(([entry]) => {
      if (entry) sync(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(el);
    sync(el.clientWidth, el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Fit the freshly-loaded scene into view once the viewport has a size.
  const fittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (size.width < 2 || size.height < 2) return;
    const key = sourceId ?? "";
    if (fittedRef.current === key) return;
    fittedRef.current = key;
    useEditorStore.getState().zoomToFit(size.width, size.height);
  }, [sourceId, size.width, size.height]);

  const screenToScene = useCallback(
    (clientX: number, clientY: number): Vec2 => {
      const rect = hostRef.current?.getBoundingClientRect();
      const vp = useEditorStore.getState().viewport;
      const lx = clientX - (rect?.left ?? 0);
      const ly = clientY - (rect?.top ?? 0);
      return { x: (lx - vp.panX) / vp.zoom, y: (ly - vp.panY) / vp.zoom };
    },
    []
  );

  // Candidate snap lines for a gesture: every visible peer's edges/centers
  // plus the artboard center, with the moving selection excluded. Built once
  // per gesture (targets are static while dragging).
  const buildLines = useCallback(
    (movingIds: readonly string[]): SnapLine[] => {
      const store = useEditorStore.getState();
      const exclude = excludeSet(store.nodes, movingIds);
      const roots: SceneNode[] = [];
      for (const id of rootIds) {
        const n = store.nodes[id];
        if (n && !exclude.has(id)) roots.push(n);
      }
      return buildSnapLines(store.nodes, exclude, unionBounds(roots));
    },
    [rootIds]
  );

  // Start a move gesture. Snap lines + start bounds (and any Alt-duplicate) are
  // resolved lazily on the first real drag so a bare click never mutates.
  const beginMove = useCallback((scene: Vec2, alt: boolean) => {
    gestureRef.current = {
      kind: "move",
      origin: scene,
      start: null,
      applied: { x: 0, y: 0 },
      moved: false,
      lines: [],
    };
    moveAltRef.current = alt;
    useEditorStore.getState().setActiveGesture("move");
  }, []);

  // ----- Pen tool: click to place anchors; Enter/dbl-click finishes, Esc cancels.
  const finishPen = useCallback((closed: boolean) => {
    const store = useEditorStore.getState();
    const pen = store.pen;
    store.setPen(null);
    if (!pen || pen.points.length < 2) return;
    store.addNode(makePath(pen.points, closed));
  }, []);

  const addPenPoint = useCallback(
    (scene: Vec2) => {
      const store = useEditorStore.getState();
      const pen = store.pen;
      if (!pen) {
        store.setPen({ points: [scene], cursor: scene });
        return;
      }
      const first = pen.points[0];
      // Click near the first anchor closes the path.
      if (first && pen.points.length >= 3) {
        const d =
          Math.hypot(scene.x - first.x, scene.y - first.y) *
          store.viewport.zoom;
        if (d <= 10) {
          finishPen(true);
          return;
        }
      }
      store.setPen({ points: [...pen.points, scene], cursor: scene });
    },
    [finishPen]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!useEditorStore.getState().pen) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finishPen(false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        useEditorStore.getState().setPen(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [finishPen]);

  // Cancel any open pen path when switching away from the pen tool.
  useEffect(() => {
    if (tool !== "pen") useEditorStore.getState().setPen(null);
  }, [tool]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      const store = useEditorStore.getState();
      hostRef.current?.setPointerCapture(e.pointerId);

      // Pan: hand tool, space held (tempPan), or middle mouse.
      if (store.tool === "hand" || store.tempPan || e.button === 1) {
        gestureRef.current = {
          kind: "pan",
          lastX: e.clientX,
          lastY: e.clientY,
        };
        store.setActiveGesture("pan");
        return;
      }

      const target = e.target as Element;

      // Crop is modal: while a session is open the canvas only edits the crop
      // window — never picks, marquees or draws. A press on a handle resizes;
      // a press inside the window slides it; anything else is ignored.
      if (store.cropSession) {
        const cropHandle = target.getAttribute(
          "data-crop"
        ) as ResizeHandle | null;
        const at = screenToScene(e.clientX, e.clientY);
        if (cropHandle || pointInCrop(at, store.cropSession.rect)) {
          gestureRef.current = {
            kind: "crop",
            handle: cropHandle,
            start: store.cropSession.rect,
            origin: at,
          };
          store.setActiveGesture("crop");
        }
        return;
      }

      const handle = target.getAttribute("data-handle") as ResizeHandle | null;
      const endpoint = target.getAttribute("data-endpoint") as "a" | "b" | null;
      const rotate = target.getAttribute("data-rotate");
      const single =
        store.selectedIds.length === 1
          ? store.nodes[store.selectedIds[0]!]
          : null;

      if (handle && single) {
        store.pushHistory();
        gestureRef.current = {
          kind: "resize",
          id: single.id,
          handle,
          start: {
            x: single.x,
            y: single.y,
            width: single.width,
            height: single.height,
          },
          rotation: single.rotation,
          lines: store.snapEnabled ? buildLines([single.id]) : [],
        };
        store.setActiveGesture("resize");
        return;
      }
      if (rotate && single) {
        store.pushHistory();
        gestureRef.current = {
          kind: "rotate",
          id: single.id,
          center: {
            x: single.x + single.width / 2,
            y: single.y + single.height / 2,
          },
        };
        store.setActiveGesture("rotate");
        return;
      }
      if (endpoint && single && isLineLike(single)) {
        store.pushHistory();
        gestureRef.current = {
          kind: "endpoint",
          id: single.id,
          which: endpoint,
          ax: single.x,
          ay: single.y,
          bx: single.x + single.width,
          by: single.y + single.height,
        };
        store.setActiveGesture("endpoint");
        return;
      }
      const grad = target.getAttribute("data-grad");
      if (grad && single && store.gradientEditFillId) {
        const fill = single.fills.find(
          (f) => f.id === store.gradientEditFillId && f.gradient
        );
        if (fill?.gradient) {
          // One undo step per drag via the lazy history transaction (PR-Pa.1).
          store.beginHistory();
          gestureRef.current = {
            kind: "gradient",
            id: single.id,
            fillId: fill.id,
            which:
              grad === "point"
                ? "point"
                : grad === "mesh"
                  ? "mesh"
                  : (grad as GradientHandle),
            pointId:
              grad === "point" || grad === "mesh"
                ? (target.getAttribute("data-grad-id") ?? undefined)
                : undefined,
            gradient: fill.gradient,
            geo: gradientGeometry(fill.gradient),
          };
          store.setActiveGesture("gradient");
          return;
        }
      }

      // Callout tail: dragging the tip handle swings/lengthens the tail. One
      // undo step per drag via the lazy history transaction, like gradients.
      const callout = target.getAttribute("data-callout");
      if (callout && single && single.callout) {
        store.beginHistory();
        gestureRef.current = { kind: "tail", id: single.id };
        store.setActiveGesture("tail");
        return;
      }

      const scene = screenToScene(e.clientX, e.clientY);

      // Image tool: defer to the file picker, drop the bitmap at the click.
      if (store.tool === "image") {
        pendingImagePoint.current = scene;
        fileRef.current?.click();
        return;
      }
      // Pencil: freehand drag captures a point stream into a path.
      if (store.tool === "pencil") {
        gestureRef.current = { kind: "pencil", points: [scene], id: null };
        store.setActiveGesture("draw");
        return;
      }

      // Pen: each click places an anchor (no drag gesture).
      if (store.tool === "pen") {
        addPenPoint(scene);
        return;
      }

      // Drawing tools (rect-drag).
      const def = TOOL_BY_ID[store.tool];
      if (def?.draws) {
        gestureRef.current = {
          kind: "draw",
          start: scene,
          created: false,
          id: null,
        };
        store.setActiveGesture("draw");
        return;
      }

      // Select tool. Pressing within the current selection moves it without
      // re-picking; otherwise pick the topmost object under the cursor (deep,
      // so annotations inside a frame are grabbed directly, not the frame).
      const tol = 6 / store.viewport.zoom;
      const onSelection =
        !e.shiftKey &&
        store.selectedIds.some((id) => {
          const n = store.nodes[id];
          return n ? hitTestNode(n, scene, tol) : false;
        });
      if (onSelection) {
        beginMove(scene, e.altKey);
        return;
      }
      const hit = pickNode(store.nodes, rootIds, scene, tol, true);
      if (hit) {
        if (e.shiftKey) store.toggleSelection(hit);
        else store.select([hit]);
        beginMove(scene, e.altKey);
      } else {
        if (!e.shiftKey) store.clearSelection();
        gestureRef.current = { kind: "marquee", start: scene };
        store.setActiveGesture("marquee");
        setMarquee({ x: scene.x, y: scene.y, width: 0, height: 0 });
      }
    },
    [rootIds, screenToScene, buildLines, beginMove, addPenPoint]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const g = gestureRef.current;
      const store = useEditorStore.getState();
      // The scene cursor feeds only the rulers' coordinate readout, so skip the
      // per-move store write (and the store-wide subscriber notification it
      // triggers) whenever the rulers are hidden.
      if (store.showRulers)
        store.setCursor(screenToScene(e.clientX, e.clientY));
      if (!g) {
        if (store.tool === "select") {
          const scene = screenToScene(e.clientX, e.clientY);
          setHoverId(
            pickNode(store.nodes, rootIds, scene, 6 / store.viewport.zoom, true)
          );
        } else {
          if (hoverId) setHoverId(null);
          // Pen rubber-band: track the cursor for the live preview segment.
          if (store.tool === "pen" && store.pen) {
            store.setPen({
              points: store.pen.points,
              cursor: screenToScene(e.clientX, e.clientY),
            });
          }
        }
        return;
      }

      const scene = screenToScene(e.clientX, e.clientY);

      switch (g.kind) {
        case "pan": {
          store.panBy(e.clientX - g.lastX, e.clientY - g.lastY);
          g.lastX = e.clientX;
          g.lastY = e.clientY;
          break;
        }
        case "marquee": {
          setMarquee(normalizeRect(g.start, scene));
          break;
        }
        case "move": {
          let dx = scene.x - g.origin.x;
          let dy = scene.y - g.origin.y;
          if (!g.moved) {
            if (Math.hypot(dx, dy) * store.viewport.zoom < DRAG_THRESHOLD)
              break;
            // Alt-drag duplicates in place; the clone becomes the moving
            // selection. The duplicate is the single history entry, so we skip
            // the usual pre-move snapshot in that case.
            if (moveAltRef.current && store.selectedIds.length > 0) {
              store.duplicateNodes(store.selectedIds, 0);
            } else {
              store.pushHistory();
            }
            // Re-read after the (possible) duplicate — the clones are now the
            // selection, so start bounds + snap lines must reflect them.
            const live = useEditorStore.getState();
            const sel = live.selectedIds
              .map((id) => live.nodes[id])
              .filter((n): n is SceneNode => !!n);
            g.start = unionBounds(sel);
            g.lines = live.snapEnabled ? buildLines(live.selectedIds) : [];
            g.moved = true;
          }
          if (!g.start) break;
          // Shift constrains to the dominant axis.
          if (e.shiftKey) {
            if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
            else dx = 0;
          }
          let guides: Guide[] = [];
          // Cmd/Ctrl bypasses snapping for fine placement.
          if (store.snapEnabled && !(e.metaKey || e.ctrlKey)) {
            const proposed = {
              x: g.start.x + dx,
              y: g.start.y + dy,
              width: g.start.width,
              height: g.start.height,
            };
            const snap = snapMove(proposed, g.lines, store.viewport.zoom);
            dx += snap.dx;
            dy += snap.dy;
            guides = snap.guides;
          }
          const cur = useEditorStore.getState();
          cur.moveNodes(cur.selectedIds, dx - g.applied.x, dy - g.applied.y, {
            transient: true,
          });
          g.applied = { x: dx, y: dy };
          store.setGuides(guides);
          store.setTransformHud({
            text: `${Math.round(g.start.x + dx)}, ${Math.round(g.start.y + dy)}`,
            sx: g.start.x + dx + g.start.width / 2,
            sy: g.start.y + dy + g.start.height,
          });
          break;
        }
        case "draw": {
          const def = TOOL_BY_ID[store.tool];
          // A dimension is a line node, so it drafts like one: the rect carries
          // the signed a→b vector and Shift snaps the aim to 45°.
          const lineLike =
            store.tool === "line" ||
            store.tool === "arrow" ||
            store.tool === "measure";
          // Shift constrains the draft as it's drawn: a square for box shapes,
          // 45° increments for lines/arrows. Read live so press/release flips it.
          // A stamp is constrained *always*: its glyph is fit into the largest
          // centered square of the frame (`lib/stamps.ts`), so a free drag would
          // only pad the mark with dead space and a loose selection box.
          const rect = drawRect(
            g.start,
            scene,
            lineLike,
            e.shiftKey || store.tool === "stamp"
          );
          if (!g.created) {
            if (
              Math.hypot(scene.x - g.start.x, scene.y - g.start.y) *
                store.viewport.zoom <
              DRAG_THRESHOLD
            )
              break;
            const node = createNodeForTool(store.tool, rect, store.mode);
            if (!node || !def) break;
            store.addNode(node);
            g.created = true;
            g.id = node.id;
          } else if (g.id) {
            store.updateNode(g.id, rect, { transient: true });
          }
          if (g.created) {
            const nb = normalizeRect(
              { x: rect.x, y: rect.y },
              { x: rect.x + rect.width, y: rect.y + rect.height }
            );
            store.setTransformHud({
              text: `${Math.round(nb.width)} × ${Math.round(nb.height)}`,
              sx: nb.x + nb.width / 2,
              sy: nb.y + nb.height,
            });
          }
          break;
        }
        case "pencil": {
          g.points.push(scene);
          if (!g.id) {
            if (g.points.length < 2) break;
            const node = makePath(g.points, false);
            store.addNode(node);
            g.id = node.id;
          } else {
            store.updateNode(g.id, pathGeometry(g.points), { transient: true });
          }
          break;
        }
        case "resize": {
          const node = store.nodes[g.id];
          let pointer = scene;
          // Snap the dragged handle to peers (axis-aligned nodes only — snapping
          // a rotated frame's pointer would fight the rotation).
          if (
            node &&
            node.rotation === 0 &&
            store.snapEnabled &&
            !(e.metaKey || e.ctrlKey) &&
            g.lines.length > 0
          ) {
            pointer = snapPoint(scene, g.lines, store.viewport.zoom);
          }
          // Shift (or a node's lockAspect) keeps the ratio; Alt resizes from
          // the center. Both are read live each move, so pressing/releasing a
          // modifier mid-drag flips the behavior immediately.
          const keepAspect = e.shiftKey || (node?.lockAspect ?? false);
          store.resizeNode(g.id, g.handle, pointer, g.start, g.rotation, {
            transient: true,
            keepAspect,
            fromCenter: e.altKey,
          });
          const after = store.nodes[g.id];
          if (after) {
            const aabb = rotatedAABB(after);
            store.setGuides(
              store.snapEnabled
                ? alignmentGuides(aabb, g.lines, SNAP_PX / store.viewport.zoom)
                : []
            );
            store.setTransformHud({
              text: `${Math.round(after.width)} × ${Math.round(after.height)}`,
              sx: aabb.x + aabb.width / 2,
              sy: aabb.y + aabb.height,
              aspectLocked: keepAspect,
            });
          }
          break;
        }
        case "rotate": {
          let deg = angleFromCenter(g.center, scene);
          if (e.shiftKey) deg = Math.round(deg / ROTATE_SNAP) * ROTATE_SNAP;
          store.rotateNode(g.id, deg, { transient: true });
          const n = store.nodes[g.id];
          if (n) {
            const aabb = rotatedAABB(n);
            store.setTransformHud({
              text: `${Math.round(((deg % 360) + 360) % 360)}°`,
              sx: aabb.x + aabb.width / 2,
              sy: aabb.y + aabb.height,
            });
          }
          break;
        }
        case "endpoint": {
          const patch =
            g.which === "b"
              ? {
                  x: g.ax,
                  y: g.ay,
                  width: scene.x - g.ax,
                  height: scene.y - g.ay,
                }
              : {
                  x: scene.x,
                  y: scene.y,
                  width: g.bx - scene.x,
                  height: g.by - scene.y,
                };
          store.updateNode(g.id, patch, { transient: true });
          break;
        }
        case "crop": {
          const session = store.cropSession;
          if (!session) break;
          // Shift locks the ratio mid-drag (matching the resize gesture): the
          // session's own lock when it has one, otherwise the crop's current
          // shape.
          const aspect = e.shiftKey
            ? (session.aspect ?? cropAspectRatio(g.start))
            : session.aspect;
          const rect = g.handle
            ? resizeCrop(g.start, g.handle, scene, aspect)
            : moveCrop(g.start, scene.x - g.origin.x, scene.y - g.origin.y);
          store.setCropRect(rect);
          store.setTransformHud({
            text: `${Math.round(rect.width)} × ${Math.round(rect.height)}`,
            sx: rect.x + rect.width / 2,
            sy: rect.y + rect.height,
          });
          break;
        }
        case "gradient": {
          const node = store.nodes[g.id];
          if (!node || node.width <= 0 || node.height <= 0) break;
          // Pointer → the node's frame-local box, normalized 0..1 (rotation off).
          const local = sceneToFrameLocal(scene, node);
          const p = { x: local.x / node.width, y: local.y / node.height };
          const patched =
            g.which === "point" && g.pointId
              ? moveFreeformPoint(g.gradient, g.pointId, p)
              : g.which === "mesh" && g.pointId
                ? moveMeshPoint(g.gradient, Number(g.pointId), p)
                : applyGradientHandle(
                    g.which as GradientHandle,
                    g.gradient,
                    g.geo,
                    p
                  );
          store.updateFill(g.id, g.fillId, { gradient: patched });
          break;
        }
        case "tail": {
          const node = store.nodes[g.id];
          if (!node?.callout || node.width <= 0 || node.height <= 0) break;
          // Pointer → the node's frame-local box (rotation removed), then invert
          // to the tail's aim + reach.
          const local = sceneToFrameLocal(scene, node);
          const { angle: raw, length } = calloutTailFromLocal(node, local);
          // Shift snaps the aim to 15° increments, matching the rotate gesture.
          const angle = e.shiftKey
            ? Math.round(raw / ROTATE_SNAP) * ROTATE_SNAP
            : raw;
          store.updateNode(g.id, {
            callout: { ...node.callout, angle, length },
          });
          store.setTransformHud({
            text: `${Math.round(angle)}° · ${Math.round(length)}px`,
            sx: node.x + node.width / 2,
            sy: node.y + node.height,
          });
          break;
        }
      }
    },
    [rootIds, screenToScene, hoverId, buildLines]
  );

  const endGesture = useCallback(
    (e: ReactPointerEvent) => {
      const g = gestureRef.current;
      gestureRef.current = null;
      moveAltRef.current = false;
      hostRef.current?.releasePointerCapture(e.pointerId);
      const store = useEditorStore.getState();
      // Tear down all transient gesture chrome regardless of the gesture kind.
      store.setGuides([]);
      store.setTransformHud(null);
      store.setActiveGesture(null);
      if (!g) return;

      if (g.kind === "gradient" || g.kind === "tail") {
        store.endHistory(); // commit the coalesced drag as one undo step
        return;
      }

      if (g.kind === "marquee") {
        const rect = normalizeRect(
          g.start,
          screenToScene(e.clientX, e.clientY)
        );
        setMarquee(null);
        if (rect.width < 1 && rect.height < 1) return;
        const hits = rootIds.filter((id) => {
          const node = store.nodes[id];
          return (
            node &&
            node.visible &&
            !node.locked &&
            rectsIntersect(rotatedAABB(node), rect)
          );
        });
        store.select(
          e.shiftKey ? [...new Set([...store.selectedIds, ...hits])] : hits
        );
        return;
      }

      if (g.kind === "draw") {
        if (!g.created) {
          // A click without a drag → drop a default-sized node.
          createDefault(g.start);
        }
        store.setTool("select");
      }
    },
    [rootIds, screenToScene]
  );

  const createDefault = (point: Vec2) => {
    const store = useEditorStore.getState();
    if (store.tool === "text") {
      const node = makeText({ x: point.x, y: point.y, width: 220, height: 32 });
      store.addNode(node);
      store.setEditingText(node.id);
      return;
    }
    const rect = { x: point.x, y: point.y, width: 120, height: 120 };
    const node = createNodeForTool(store.tool, rect, store.mode);
    if (node) store.addNode(node);
  };

  // Wheel/trackpad gestures. React routes `onWheel` through a *passive* root
  // listener, so its `preventDefault` is ignored and the webview's own
  // pinch-zoom/scroll fights ours. Bind a non-passive native listener instead:
  //   • ctrl/⌘ + wheel  → trackpad pinch (and ctrl-scroll) → zoom about cursor
  //   • two-finger pan  → pan; Shift turns a vertical wheel into horizontal pan
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      const store = useEditorStore.getState();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0125);
        store.setZoom(clampZoom(store.viewport.zoom * factor), {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          vw: rect.width,
          vh: rect.height,
        });
      } else if (e.shiftKey && e.deltaX === 0) {
        store.panBy(-e.deltaY, 0);
      } else {
        store.panBy(-e.deltaX, -e.deltaY);
      }
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, []);

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent) => {
      const store = useEditorStore.getState();
      if (store.pen) {
        finishPen(false);
        return;
      }
      // Crop owns the canvas while it's open — don't re-select underneath it.
      if (store.cropSession) return;
      const scene = screenToScene(e.clientX, e.clientY);
      const hit = pickNode(
        store.nodes,
        rootIds,
        scene,
        6 / store.viewport.zoom,
        true
      );
      if (!hit) return;
      store.select([hit]);
      if (store.nodes[hit]?.type === "text") store.setEditingText(hit);
    },
    [rootIds, screenToScene, finishPen]
  );

  const onContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      // The canvas answers its own right-clicks. Stopping propagation is
      // what tells the window-level fallback (`useNativeContextMenu`) the
      // click found an owner, so the shared menu doesn't open on top of
      // the editor's. Suppressing the WebView2 menu is already handled
      // globally in the capture phase — the `preventDefault` above only
      // matters for the crop-session early return below.
      e.stopPropagation();
      const store = useEditorStore.getState();
      if (store.cropSession) return;
      const scene = screenToScene(e.clientX, e.clientY);
      const hit = pickNode(
        store.nodes,
        rootIds,
        scene,
        6 / store.viewport.zoom,
        true
      );
      if (hit && !store.selectedIds.includes(hit)) store.select([hit]);
      store.openContextMenu({
        x: e.clientX,
        y: e.clientY,
        sceneX: scene.x,
        sceneY: scene.y,
        kind: hit ? "node" : "canvas",
      });
    },
    [rootIds, screenToScene]
  );

  // Load an image File and drop it as a node centered on `point` (scene space).
  // Shared by the image-tool file picker and drag-and-drop.
  const placeImageFile = useCallback((file: File, point: Vec2) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === "string" ? reader.result : "";
      if (!src) return;
      const img = new Image();
      img.onload = () => {
        const max = 720;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const store = useEditorStore.getState();
        const node = makeImage(
          { x: point.x - w / 2, y: point.y - h / 2, width: w, height: h },
          src,
          { name: file.name }
        );
        store.addNode(node);
        store.setTool("select");
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  }, []);

  const onFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      const point = pendingImagePoint.current;
      if (file && point) placeImageFile(file, point);
    },
    [placeImageFile]
  );

  // Drag an image file from the OS onto the canvas to place it where it lands.
  const onDragOver = useCallback((e: ReactDragEvent) => {
    if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) {
      e.preventDefault();
    }
  }, []);

  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      const file = Array.from(e.dataTransfer.files).find((f) =>
        f.type.startsWith("image/")
      );
      if (!file) return;
      e.preventDefault();
      placeImageFile(file, screenToScene(e.clientX, e.clientY));
    },
    [placeImageFile, screenToScene]
  );

  const selectionBounds = unionBounds(
    selectedIds.map((id) => nodes[id]).filter((n): n is SceneNode => !!n)
  );
  const single =
    selectedIds.length === 1 ? (nodes[selectedIds[0]!] ?? null) : null;
  const interacting = gestureRef.current !== null;

  const cursor =
    tempPan || tool === "hand"
      ? gestureRef.current?.kind === "pan"
        ? "grabbing"
        : "grab"
      : tool === "select"
        ? "default"
        : // Dragging inside the crop window slides it; the handles set their
          // own resize cursors, which win over this one.
          tool === "crop"
          ? "move"
          : "crosshair";

  return (
    <div
      ref={hostRef}
      className="relative h-full w-full overflow-hidden"
      style={{ background: "var(--ed-canvas)", cursor, touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onPointerLeave={() => useEditorStore.getState().setCursor(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <CanvasGrid viewport={viewport} show={showGrid} />
      <SelectionShadow node={single} viewport={viewport} />

      <svg
        className="absolute inset-0 h-full w-full"
        style={{ pointerEvents: "none" }}
      >
        <g
          transform={`translate(${viewport.panX} ${viewport.panY}) scale(${viewport.zoom})`}
        >
          {rootIds.map((id) => {
            const node = nodes[id];
            return node ? (
              <SceneNodeView key={id} node={node} nodes={nodes} />
            ) : null;
          })}
        </g>
      </svg>

      <SelectionOverlay
        nodes={nodes}
        selectedIds={selectedIds}
        viewport={viewport}
        hoverId={tool === "select" && !interacting ? hoverId : null}
        marquee={marquee}
        interacting={interacting}
        gradientEditFillId={gradientEditFillId}
      />

      <CropOverlay viewport={viewport} />

      <CanvasGuides viewport={viewport} />
      <PenOverlay viewport={viewport} />

      <ObjectLabel node={single} viewport={viewport} hidden={interacting} />
      <FloatingToolbar node={single} viewport={viewport} hidden={interacting} />
      <TransformHud />

      {showRulers && (
        <CanvasRulers
          viewport={viewport}
          width={size.width}
          height={size.height}
          selection={selectionBounds}
        />
      )}

      {/* Bottom rail: the zoom cluster centres under the canvas — it belongs to
          the view, not to either side of it — and the hint stacks above rather
          than beside it, so neither has to yield space as the canvas narrows. */}
      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex flex-col items-center gap-2">
        <CanvasHintBar />
        <CanvasZoomControls />
      </div>

      {editingTextId && (
        <TextEditor nodeId={editingTextId} nodes={nodes} viewport={viewport} />
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFileChange}
      />
    </div>
  );
}

interface TextEditorProps {
  nodeId: string;
  nodes: Record<string, SceneNode>;
  viewport: Viewport;
}

/** Inline editor for a text node — an absolutely-positioned textarea matching
 *  the node's screen rect + typography. Commits on blur/Escape. */
function TextEditor({ nodeId, nodes, viewport }: TextEditorProps) {
  const node = nodes[nodeId];
  const ref = useRef<HTMLTextAreaElement>(null);
  const pushedRef = useRef(false);

  useEffect(() => {
    pushedRef.current = false;
    const el = ref.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [nodeId]);

  if (!node || node.type !== "text") return null;

  const left = node.x * viewport.zoom + viewport.panX;
  const top = node.y * viewport.zoom + viewport.panY;

  return (
    <textarea
      ref={ref}
      defaultValue={node.text}
      onChange={(e) => {
        if (!pushedRef.current) {
          useEditorStore.getState().pushHistory();
          pushedRef.current = true;
        }
        useEditorStore
          .getState()
          .setText(nodeId, e.target.value, { transient: true });
      }}
      onBlur={() => useEditorStore.getState().setEditingText(null)}
      onKeyDown={(e) => {
        // Editor-owned text editing: Esc cancels, Mod+Enter commits; plain
        // Enter still inserts a newline. stopPropagation keeps these keys from
        // reaching the canvas/global keybind handlers while typing.
        if (e.key === "Escape") {
          e.preventDefault();
          useEditorStore.getState().setEditingText(null);
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          useEditorStore.getState().setEditingText(null);
        }
        e.stopPropagation();
      }}
      className="absolute resize-none border-none bg-transparent p-0 outline-none"
      style={{
        left,
        top,
        width: Math.max(node.width, 40) * viewport.zoom,
        minHeight: node.fontSize * viewport.zoom,
        transformOrigin: "top left",
        transform: `scale(1)`,
        fontFamily: '"Inter", system-ui, sans-serif',
        fontSize: node.fontSize * viewport.zoom,
        fontWeight: node.fontWeight,
        lineHeight: node.lineHeight,
        letterSpacing: node.letterSpacing * viewport.zoom,
        color: node.color,
        textAlign: node.align,
        caretColor: "var(--ed-accent)",
        outline: "1px solid var(--ed-accent)",
        zIndex: 10,
      }}
    />
  );
}
