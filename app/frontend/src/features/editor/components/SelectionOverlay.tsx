import {
  calloutTailGeometry,
  handlePoint,
  nodeCorners,
  rotatePoint,
  rotationHandlePoint,
  unionBounds,
  RESIZE_HANDLES,
  type ResizeHandle,
} from "../geometry";
import {
  isLineLike,
  lineEndpoints,
  meshSlotPoint,
  type ArrowNode,
  type LineNode,
  type Paint,
  type Rect,
  type SceneNode,
  type Vec2,
} from "../types";
import { gradientGeometry } from "../lib/paint";
import type { Viewport } from "../state/editorStore";

interface SelectionOverlayProps {
  nodes: Record<string, SceneNode>;
  selectedIds: readonly string[];
  viewport: Viewport;
  /** Node under the cursor (select tool) to outline faintly, if not selected. */
  hoverId: string | null;
  /** Live marquee rectangle in scene space, if a marquee drag is active. */
  marquee: Rect | null;
  /** Suppress handles while a transform/marquee gesture is in flight. */
  interacting: boolean;
  /** Fill id whose gradient is being edited on-canvas — shows its handles. */
  gradientEditFillId: string | null;
}

const HANDLE = 8;
const ROTATE_GAP = 22;

const HANDLE_CURSOR: Record<ResizeHandle, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

/**
 * Screen-space selection chrome: bounding box, resize/rotate handles (single
 * box selection), endpoint handles (single line), a plain box for multi-select,
 * plus the hover outline and marquee rect. Purely presentational — handles
 * carry `data-handle` / `data-endpoint` / `data-rotate` attributes that
 * EditorCanvas reads on pointer-down to start the matching gesture.
 */
export function SelectionOverlay({
  nodes,
  selectedIds,
  viewport,
  hoverId,
  marquee,
  interacting,
  gradientEditFillId,
}: SelectionOverlayProps) {
  const toScreen = (p: Vec2): Vec2 => ({
    x: p.x * viewport.zoom + viewport.panX,
    y: p.y * viewport.zoom + viewport.panY,
  });

  const selected = selectedIds
    .map((id) => nodes[id])
    .filter((n): n is SceneNode => !!n);
  const hover =
    hoverId && !selectedIds.includes(hoverId) ? nodes[hoverId] : null;
  const single = selected.length === 1 ? selected[0]! : null;
  // The gradient fill being edited on-canvas (if its node is the selection).
  const gradientFill =
    single && gradientEditFillId
      ? (single.fills.find(
          (f) =>
            f.id === gradientEditFillId && f.type === "gradient" && f.gradient
        ) ?? null)
      : null;

  return (
    <svg
      className="absolute inset-0 h-full w-full"
      style={{ pointerEvents: "none", overflow: "visible" }}
    >
      {hover && (
        <OutlineBox
          corners={nodeCorners(hover).map(toScreen)}
          color="var(--ed-accent)"
          width={1}
          dashed
        />
      )}

      {/* Multi-select: a single AABB, no handles. */}
      {selected.length > 1 && (
        <ScreenRect rect={screenRect(unionBounds(selected), toScreen)} />
      )}

      {single && !isLineLike(single) && (
        <BoxSelection
          node={single}
          toScreen={toScreen}
          interacting={interacting}
        />
      )}

      {single && isLineLike(single) && (
        <LineSelection
          node={single}
          toScreen={toScreen}
          interacting={interacting}
        />
      )}

      {/* Gradient handles render on top, even mid-drag, so the line tracks. */}
      {single && gradientFill && (
        <GradientHandles
          node={single}
          fill={gradientFill}
          toScreen={toScreen}
        />
      )}

      {/* Callout tail: a grab handle on the tip. Renders even mid-drag so it
          tracks the pointer, like the gradient handles. */}
      {single && single.callout && (
        <CalloutTailHandle node={single} toScreen={toScreen} />
      )}

      {marquee && <MarqueeRect rect={screenRect(marquee, toScreen)} />}
    </svg>
  );
}

/**
 * Draggable handles for editing a gradient fill on the canvas (Workstream G2).
 * Linear shows start/end; radial shows center, a radius handle (+x edge), and
 * the focal point — each a dot carrying `data-grad` that EditorCanvas reads on
 * pointer-down. Positions track the node's rotation, like the resize handles.
 */
function GradientHandles({
  node,
  fill,
  toScreen,
}: {
  node: SceneNode;
  fill: Paint;
  toScreen: (p: Vec2) => Vec2;
}) {
  const g = fill.gradient!;
  const geo = gradientGeometry(g);
  const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  const at = (nx: number, ny: number): Vec2 =>
    toScreen(
      rotatePoint(
        { x: node.x + nx * node.width, y: node.y + ny * node.height },
        center,
        node.rotation
      )
    );

  if (g.kind === "mesh" && g.mesh) {
    const m = g.mesh;
    const nodeAt = (idx: number): Vec2 => {
      const j = Math.floor(idx / m.cols);
      const i = idx % m.cols;
      const p = m.points[idx]?.point ?? meshSlotPoint(m.rows, m.cols, j, i);
      return at(p.x, p.y);
    };
    const poly = (pts: Vec2[], key: string) => (
      <polyline
        key={key}
        points={pts.map((q) => `${q.x},${q.y}`).join(" ")}
        fill="none"
        stroke="var(--ed-handle-fill)"
        strokeWidth={1.5}
        opacity={0.8}
      />
    );
    return (
      <>
        {/* Lattice lines (rows then columns) make the warp legible. */}
        {Array.from({ length: m.rows }, (_, j) =>
          poly(
            Array.from({ length: m.cols }, (_, i) => nodeAt(j * m.cols + i)),
            `r${j}`
          )
        )}
        {Array.from({ length: m.cols }, (_, i) =>
          poly(
            Array.from({ length: m.rows }, (_, j) => nodeAt(j * m.cols + i)),
            `c${i}`
          )
        )}
        {m.points.map((_, idx) => (
          <GradDot
            key={idx}
            p={nodeAt(idx)}
            which="mesh"
            pointId={String(idx)}
          />
        ))}
      </>
    );
  }

  if (g.kind === "freeform") {
    if ((g.freeformMode ?? "points") === "lines") {
      return (
        <>
          {(g.lines ?? []).map((line) => (
            <g key={line.id}>
              <polyline
                points={line.stops
                  .map((s) => {
                    const q = at(s.point.x, s.point.y);
                    return `${q.x},${q.y}`;
                  })
                  .join(" ")}
                fill="none"
                stroke="var(--ed-handle-fill)"
                strokeWidth={1.5}
                opacity={0.8}
              />
              {line.stops.map((s) => (
                <GradDot
                  key={s.id}
                  p={at(s.point.x, s.point.y)}
                  which="point"
                  pointId={s.id}
                />
              ))}
            </g>
          ))}
        </>
      );
    }
    return (
      <>
        {(g.points ?? []).map((p) => (
          <GradDot
            key={p.id}
            p={at(p.point.x, p.point.y)}
            which="point"
            pointId={p.id}
          />
        ))}
      </>
    );
  }

  if (g.kind === "linear") {
    const a = at(geo.start.x, geo.start.y);
    const b = at(geo.end.x, geo.end.y);
    return (
      <>
        <Connector a={a} b={b} />
        <GradDot p={a} which="start" />
        <GradDot p={b} which="end" />
      </>
    );
  }

  const c = at(geo.center.x, geo.center.y);
  const edge = at(geo.center.x + geo.radius, geo.center.y);
  const focal = at(geo.focal.x, geo.focal.y);
  return (
    <>
      <Connector a={c} b={edge} />
      <GradDot p={edge} which="radius" />
      <GradDot p={c} which="center" />
      <GradDot p={focal} which="focal" hollow />
    </>
  );
}

/**
 * The drag handle on a callout's tail tip. A press on it starts EditorCanvas's
 * `tail` gesture (via `data-callout`), which swings the tail's angle and sets
 * its length from the pointer — the on-canvas counterpart to CalloutSection's
 * angle/length fields. The tip is placed by the same `calloutTailGeometry` both
 * renderers use, then rotated with the frame so it tracks a rotated bubble.
 */
function CalloutTailHandle({
  node,
  toScreen,
}: {
  node: SceneNode;
  toScreen: (p: Vec2) => Vec2;
}) {
  const tail = calloutTailGeometry(node);
  if (!tail) return null;
  const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  const base = toScreen(rotatePoint(tail.base, center, node.rotation));
  const tip = toScreen(rotatePoint(tail.tip, center, node.rotation));
  return (
    <>
      <Connector a={base} b={tip} />
      <circle
        className="ed-handle"
        cx={tip.x}
        cy={tip.y}
        r={5}
        fill="var(--ed-handle-fill)"
        stroke="var(--ed-handle-stroke)"
        strokeWidth={1.5}
        data-callout="tail"
        style={{ pointerEvents: "all", cursor: "grab" }}
      />
    </>
  );
}

function Connector({ a, b }: { a: Vec2; b: Vec2 }) {
  return (
    <>
      <line
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke="var(--ed-handle-stroke)"
        strokeWidth={2.5}
        opacity={0.5}
      />
      <line
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke="var(--ed-handle-fill)"
        strokeWidth={1}
      />
    </>
  );
}

function GradDot({
  p,
  which,
  pointId,
  hollow,
}: {
  p: Vec2;
  which: string;
  pointId?: string;
  hollow?: boolean;
}) {
  return (
    <circle
      className="ed-handle"
      cx={p.x}
      cy={p.y}
      r={5}
      fill={hollow ? "var(--ed-handle-stroke)" : "var(--ed-handle-fill)"}
      stroke={hollow ? "var(--ed-handle-fill)" : "var(--ed-handle-stroke)"}
      strokeWidth={1.5}
      data-grad={which}
      data-grad-id={pointId}
      style={{ pointerEvents: "all", cursor: "grab" }}
    />
  );
}

function BoxSelection({
  node,
  toScreen,
  interacting,
}: {
  node: SceneNode;
  toScreen: (p: Vec2) => Vec2;
  interacting: boolean;
}) {
  const corners = nodeCorners(node).map(toScreen);
  const rotateAt = toScreen(rotationHandlePoint(node, ROTATE_GAP));
  const topCenter = toScreen(handlePoint(node, "n"));
  return (
    <>
      <OutlineBox corners={corners} color="var(--ed-selection)" width={1.5} />
      {!interacting && (
        <>
          <line
            x1={topCenter.x}
            y1={topCenter.y}
            x2={rotateAt.x}
            y2={rotateAt.y}
            stroke="var(--ed-selection)"
            strokeWidth={1}
          />
          <circle
            className="ed-rotate-handle"
            cx={rotateAt.x}
            cy={rotateAt.y}
            r={5}
            fill="var(--ed-handle-fill)"
            stroke="var(--ed-handle-stroke)"
            strokeWidth={1.5}
            data-rotate="true"
            style={{ pointerEvents: "all", cursor: "grab" }}
          />
          {RESIZE_HANDLES.map((h) => {
            const p = toScreen(handlePoint(node, h));
            return (
              <rect
                key={h}
                className="ed-handle"
                x={p.x - HANDLE / 2}
                y={p.y - HANDLE / 2}
                width={HANDLE}
                height={HANDLE}
                rx={1.5}
                fill="var(--ed-handle-fill)"
                stroke="var(--ed-handle-stroke)"
                strokeWidth={1.5}
                data-handle={h}
                style={{ pointerEvents: "all", cursor: HANDLE_CURSOR[h] }}
              />
            );
          })}
        </>
      )}
    </>
  );
}

function LineSelection({
  node,
  toScreen,
  interacting,
}: {
  node: LineNode | ArrowNode;
  toScreen: (p: Vec2) => Vec2;
  interacting: boolean;
}) {
  const { a, b } = lineEndpoints(node);
  const sa = toScreen(a);
  const sb = toScreen(b);
  return (
    <>
      <line
        x1={sa.x}
        y1={sa.y}
        x2={sb.x}
        y2={sb.y}
        stroke="var(--ed-selection)"
        strokeWidth={1.5}
      />
      {!interacting &&
        (
          [
            ["a", sa],
            ["b", sb],
          ] as const
        ).map(([which, p]) => (
          <circle
            key={which}
            className="ed-handle"
            cx={p.x}
            cy={p.y}
            r={5}
            fill="var(--ed-handle-fill)"
            stroke="var(--ed-handle-stroke)"
            strokeWidth={1.5}
            data-endpoint={which}
            style={{ pointerEvents: "all", cursor: "crosshair" }}
          />
        ))}
    </>
  );
}

function OutlineBox({
  corners,
  color,
  width,
  dashed,
}: {
  corners: Vec2[];
  color: string;
  width: number;
  dashed?: boolean;
}) {
  const pts = corners.map((c) => `${c.x},${c.y}`).join(" ");
  return (
    <polygon
      points={pts}
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeDasharray={dashed ? "4 3" : undefined}
      vectorEffect="non-scaling-stroke"
    />
  );
}

function ScreenRect({ rect }: { rect: Rect }) {
  return (
    <rect
      x={rect.x}
      y={rect.y}
      width={rect.width}
      height={rect.height}
      fill="none"
      stroke="var(--ed-selection)"
      strokeWidth={1.5}
    />
  );
}

function MarqueeRect({ rect }: { rect: Rect }) {
  return (
    <rect
      x={rect.x}
      y={rect.y}
      width={rect.width}
      height={rect.height}
      fill="var(--ed-accent-soft)"
      stroke="var(--ed-selection)"
      strokeWidth={1}
    />
  );
}

function screenRect(bounds: Rect | null, toScreen: (p: Vec2) => Vec2): Rect {
  if (!bounds) return { x: 0, y: 0, width: 0, height: 0 };
  const tl = toScreen({ x: bounds.x, y: bounds.y });
  const br = toScreen({
    x: bounds.x + bounds.width,
    y: bounds.y + bounds.height,
  });
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
}
