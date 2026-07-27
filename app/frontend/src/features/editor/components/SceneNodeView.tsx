import {
  memo,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  isContainer,
  lineEndpoints,
  type ArrowNode,
  type EllipseNode,
  type FrameNode,
  type GradientPaint,
  type ImageNode,
  type LineNode,
  type PathNode,
  type Paint,
  type RectangleNode,
  type SceneNode,
  type Stroke,
  type TextNode,
} from "../types";
import {
  calloutSvgD,
  pathSvgD,
  polygonOutline,
  roundedRectPath,
  starOutline,
} from "../geometry";
import {
  chromeBarRect,
  chromeControls,
  chromeDots,
  chromeOf,
  chromeSeparator,
  chromeTitle,
  chromeWindowRadii,
  chromeWindowRect,
} from "../lib/chrome";
import { gradientGeometry, rgba } from "../lib/paint";
import { measureGeometry } from "../lib/measure";
import {
  stampGeometry,
  stampHaloWeight,
  stampOf,
  stampOutlineWeight,
} from "../lib/stamps";
import { renderFreeform } from "../lib/freeform";
import { renderMesh } from "../lib/mesh";
import { spotlightScrim } from "../lib/spotlight";
import { imagePreserveAspectRatio } from "../lib/imageFill";
import {
  findBaseImage,
  loadImage,
  pixelateRegion,
  type BaseImage,
} from "../lib/sample";

interface SceneNodeViewProps {
  node: SceneNode;
  nodes: Record<string, SceneNode>;
}

/**
 * Pure visual renderer for one scene node (and, for frames, its subtree), in
 * scene coordinates. The whole tree is `pointer-events: none` — EditorCanvas
 * owns picking via the geometry engine, so this component never handles
 * input. Rotation is applied as an SVG transform about the frame center.
 */
function SceneNodeViewImpl({ node, nodes }: SceneNodeViewProps) {
  if (!node.visible) return null;

  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const sx = node.flipH ? -1 : 1;
  const sy = node.flipV ? -1 : 1;
  const parts: string[] = [];
  if (node.rotation !== 0) parts.push(`rotate(${node.rotation} ${cx} ${cy})`);
  if (sx !== 1 || sy !== 1)
    parts.push(
      `translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`
    );
  const transform = parts.length > 0 ? parts.join(" ") : undefined;

  return (
    <g
      transform={transform}
      opacity={node.opacity}
      style={{ pointerEvents: "none", mixBlendMode: node.blendMode }}
    >
      {renderNode(node, nodes)}
    </g>
  );
}

/**
 * Re-render a node view only when its own `node` object changes — with two
 * exceptions that legitimately depend on the wider `nodes` map: containers
 * (a descendant may have moved while the frame object stayed referentially
 * equal) and sample nodes (blur/pixelate/magnify read the shared base image
 * via `findBaseImage(nodes)`). For every other node the SVG output is a pure
 * function of `node`, so an unrelated drag that merely swaps the `nodes`
 * reference must not recompute its outline/gradient/string work. This keeps a
 * drag/resize/draw gesture O(moved) instead of O(all nodes) per pointer-move.
 *
 * Spotlight nodes join containers and samples in the depends-on-`nodes` set: the
 * scrim they draw is sized from the *page frame's* rect (`spotlightPageRect`), so
 * resizing the page (crop/padding/chrome) must re-render them even though their
 * own node object didn't change.
 */
function nodeViewPropsEqual(
  prev: SceneNodeViewProps,
  next: SceneNodeViewProps
): boolean {
  if (prev.node !== next.node) return false;
  if (isContainer(next.node) || next.node.sample || next.node.spotlight)
    return prev.nodes === next.nodes;
  return true;
}

/**
 * Pure visual renderer for one scene node (and, for frames, its subtree).
 * Memoized so an unrelated scene mutation doesn't recompute every node — see
 * {@link nodeViewPropsEqual}.
 */
export const SceneNodeView = memo(SceneNodeViewImpl, nodeViewPropsEqual);

function renderNode(node: SceneNode, nodes: Record<string, SceneNode>) {
  switch (node.type) {
    case "frame":
      return <FrameView node={node} nodes={nodes} />;
    case "rectangle":
      // A stamp replaces the box's own shape entirely — its fills and strokes
      // paint the glyph, not the rectangle. Dispatched here rather than inside
      // `RectView` so the branch sits above that component's effects wrapper:
      // `render.ts` casts shadows from the *box* silhouette, so letting an SVG
      // filter reach the glyph would be the one thing the two renderers
      // couldn't agree on. Effects therefore apply to no stamp in either
      // renderer, as they already apply to no line-like mark.
      if (stampOf(node)) return <StampMark node={node} />;
      return <RectView node={node} nodes={nodes} />;
    case "image":
      return <RectView node={node} nodes={nodes} />;
    case "ellipse":
      return <EllipseView node={node} nodes={nodes} />;
    case "text":
      return <TextView node={node} />;
    case "line":
    case "arrow":
      return <LineView node={node} />;
    case "polygon":
      return (
        <PolyShape
          node={node}
          nodes={nodes}
          points={pointsAttr(polygonOutline(node))}
        />
      );
    case "star":
      return (
        <PolyShape
          node={node}
          nodes={nodes}
          points={pointsAttr(starOutline(node))}
        />
      );
    case "path":
      return <PathView node={node} nodes={nodes} />;
  }
}

function pointsAttr(pts: { x: number; y: number }[]): string {
  return pts.map((p) => `${p.x},${p.y}`).join(" ");
}

/** Renders a closed polygon outline (used by polygon + star nodes) with the
 *  node's fills, strokes, and effects — mirrors {@link EllipseView}. A sample
 *  (blur/pixelate/magnify) paints behind the fills, clipped to the polygon, so a
 *  translucent fill tints the sampled region. */
function PolyShape({
  node,
  nodes,
  points,
}: {
  node: SceneNode;
  nodes: Record<string, SceneNode>;
  points: string;
}) {
  const uid = useId();
  const clipId = `clip-${uid}`;
  const filterId = `fx-${uid}`;
  const withFx = hasEffects(node);
  const clip = usesClip(node);
  return (
    <>
      {(withFx || clip) && (
        <defs>
          {withFx && <EffectsDefs node={node} filterId={filterId} />}
          {clip && (
            <clipPath id={clipId}>
              <polygon points={points} />
            </clipPath>
          )}
        </defs>
      )}
      <g filter={withFx ? `url(#${filterId})` : undefined}>
        {sampleVisible(node) && (
          <SampledImage node={node} nodes={nodes} clipId={clipId} />
        )}
        {node.fills.map((f) =>
          f.visible && f.type === "solid" ? (
            <polygon
              key={f.id}
              points={points}
              fill={rgba(f.color, f.opacity)}
            />
          ) : null
        )}
        {node.strokes.map((s) =>
          s.visible && s.width > 0 ? (
            <polygon
              key={s.id}
              points={points}
              fill="none"
              stroke={rgba(s.color, s.opacity)}
              strokeWidth={strokeWidth(s)}
              strokeLinejoin="round"
              clipPath={s.align === "inside" ? `url(#${clipId})` : undefined}
            />
          ) : null
        )}
      </g>
    </>
  );
}

/** Freehand / pen path: a polyline (open or closed) stroked with round joins;
 *  closed paths can also carry solid fills. A sample (blur/pixelate/magnify)
 *  paints behind those fills, clipped to the path outline (implicitly closed). */
function PathView({
  node,
  nodes,
}: {
  node: PathNode;
  nodes: Record<string, SceneNode>;
}) {
  const d = pathSvgD(node);
  const uid = useId();
  const clipId = `clip-${uid}`;
  const filterId = `fx-${uid}`;
  const withFx = hasEffects(node);
  const sampled = sampleVisible(node);
  if (!d) return null;
  return (
    <>
      {(withFx || sampled) && (
        <defs>
          {withFx && <EffectsDefs node={node} filterId={filterId} />}
          {sampled && (
            <clipPath id={clipId}>
              <path d={d} />
            </clipPath>
          )}
        </defs>
      )}
      <g filter={withFx ? `url(#${filterId})` : undefined}>
        {sampled && <SampledImage node={node} nodes={nodes} clipId={clipId} />}
        {node.closed &&
          node.fills.map((f) =>
            f.visible && f.type === "solid" ? (
              <path key={f.id} d={d} fill={rgba(f.color, f.opacity)} />
            ) : null
          )}
        {node.strokes.map((s) =>
          s.visible && s.width > 0 ? (
            <path
              key={s.id}
              d={d}
              fill="none"
              stroke={rgba(s.color, s.opacity)}
              strokeWidth={s.width}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null
        )}
      </g>
    </>
  );
}

/**
 * The node's outline. With window chrome the outline is the whole window (bar +
 * capture, `lib/chrome.ts`), not just the box — which is what makes the clip,
 * the strokes and the lift shadow treat the framed screenshot as one object
 * instead of leaving a seam across the title bar. Mirrored by `render.ts`'s
 * `shapePath`.
 */
function cornerPath(node: FrameNode | RectangleNode | ImageNode): string {
  if (node.callout) return calloutSvgD(node);
  const win = chromeWindowRect(node);
  return roundedRectPath(
    win.x,
    win.y,
    win.width,
    win.height,
    chromeWindowRadii(node)
  );
}

/**
 * The title bar itself: background, buttons, title, and the hairline onto the
 * capture. Every number comes from `lib/chrome.ts`, so this and `render.ts`'s
 * `drawChrome` are two spellings of one drawing — the parity contract
 * `calloutOutline` already set for the callout tail.
 *
 * The bar's own background is a rounded rect with square *bottom* corners; the
 * window clip above has already rounded its top, so the two meet flush against
 * the capture with no double-rounding.
 */
function ChromeBar({ node }: { node: SceneNode }) {
  const spec = chromeOf(node);
  const bar = chromeBarRect(node);
  if (!spec || !bar) return null;
  const radii = chromeWindowRadii(node);
  const d = roundedRectPath(bar.x, bar.y, bar.width, bar.height, {
    tl: radii.tl,
    tr: radii.tr,
    br: 0,
    bl: 0,
  });
  const line = chromeSeparator(node);
  const title = chromeTitle(node);
  return (
    <g>
      <path d={d} fill={spec.color} />
      {line && (
        <line
          x1={line.x1}
          y1={line.y}
          x2={line.x2}
          y2={line.y}
          stroke={line.color}
          strokeOpacity={line.opacity}
          strokeWidth={1}
        />
      )}
      {chromeDots(node).map((dot, i) => (
        <circle key={i} cx={dot.cx} cy={dot.cy} r={dot.r} fill={dot.color} />
      ))}
      {chromeControls(node).map((control, i) =>
        control.strokes.map((points, j) => (
          <polyline
            key={`${i}-${j}`}
            points={points.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke={control.color}
            strokeWidth={control.width}
            strokeLinecap="square"
          />
        ))
      )}
      {title && (
        <text
          x={title.x}
          y={title.y}
          fill={title.color}
          fontSize={title.size}
          fontWeight={title.weight}
          fontFamily='"Inter", system-ui, sans-serif'
          textAnchor={title.align === "center" ? "middle" : "start"}
          dominantBaseline="central"
          style={{ userSelect: "none" }}
        >
          {title.text}
        </text>
      )}
    </g>
  );
}

/**
 * Filter element for a node's effects: layer blur (gaussian on the source),
 * drop shadow (spread via `feMorphology` → offset → blur → flood), and inner
 * shadow (offset → blur → composited inside the shape). One of each type is
 * honored. Kept in sync with `lib/render.ts` (the export path) — see ADR 0009.
 */
function EffectsDefs({
  node,
  filterId,
}: {
  node: SceneNode;
  filterId: string;
}) {
  const blur = node.effects.find((e) => e.visible && e.type === "layer-blur");
  const drop = node.effects.find((e) => e.visible && e.type === "drop-shadow");
  const inner = node.effects.find(
    (e) => e.visible && e.type === "inner-shadow"
  );
  if (!blur && !drop && !inner) return null;
  return (
    <filter
      id={filterId}
      x="-100%"
      y="-100%"
      width="300%"
      height="300%"
      colorInterpolationFilters="sRGB"
    >
      {blur && (
        <feGaussianBlur
          in="SourceGraphic"
          stdDeviation={blur.blur / 2}
          result="blurred"
        />
      )}
      {drop && (
        <>
          {drop.spread !== 0 && (
            <feMorphology
              in="SourceAlpha"
              operator={drop.spread > 0 ? "dilate" : "erode"}
              radius={Math.abs(drop.spread)}
              result="dropSpread"
            />
          )}
          <feOffset
            in={drop.spread !== 0 ? "dropSpread" : "SourceAlpha"}
            dx={drop.offsetX}
            dy={drop.offsetY}
            result="dropOff"
          />
          <feGaussianBlur
            in="dropOff"
            stdDeviation={drop.blur / 2}
            result="dropBlur"
          />
          <feFlood
            floodColor={drop.color}
            floodOpacity={drop.opacity}
            result="dropColor"
          />
          <feComposite
            in="dropColor"
            in2="dropBlur"
            operator="in"
            result="drop"
          />
        </>
      )}
      {inner && (
        <>
          <feOffset
            in="SourceAlpha"
            dx={inner.offsetX}
            dy={inner.offsetY}
            result="innerOff"
          />
          <feGaussianBlur
            in="innerOff"
            stdDeviation={inner.blur / 2}
            result="innerBlur"
          />
          <feComposite
            in="SourceAlpha"
            in2="innerBlur"
            operator="out"
            result="innerInv"
          />
          <feFlood
            floodColor={inner.color}
            floodOpacity={inner.opacity}
            result="innerColor"
          />
          <feComposite
            in="innerColor"
            in2="innerInv"
            operator="in"
            result="inner"
          />
        </>
      )}
      <feMerge>
        {drop && <feMergeNode in="drop" />}
        <feMergeNode in={blur ? "blurred" : "SourceGraphic"} />
        {inner && <feMergeNode in="inner" />}
      </feMerge>
    </filter>
  );
}

function hasEffects(node: SceneNode): boolean {
  return node.effects.some((e) => e.visible);
}

/** Whether a node paints its sampled image: it carries a sample and the effect
 *  is enabled. The sample renders *behind* the fills, so fills stay visible (a
 *  translucent fill tints the sample); a hidden sample (the Effects panel eye
 *  toggle) just isn't drawn, leaving the fills — or, for a fill-less annotation
 *  region, the capture beneath. */
function sampleVisible(node: SceneNode): boolean {
  return Boolean(node.sample) && node.sample!.enabled !== false;
}

/**
 * Whether anything this node actually renders references its clip path: a
 * sample (blur/pixelate/magnify), an image fill, or an inside-aligned stroke.
 * A plain shape — solid/gradient fill with a centre/outside stroke — references
 * no clip, so emitting the `<clipPath>` (and the `<defs>` that wraps it) for it
 * is pure DOM + reconciliation waste: in a typical annotation scene the vast
 * majority of shapes are plain, and each was previously paying for an unused
 * `<defs><clipPath><path/></clipPath></defs>` every render. Frames additionally
 * clip when `clipContent` is set (handled in {@link FrameView}). Over-
 * approximating is harmless (an unreferenced clip is inert); under-approximating
 * would drop a needed clip, so keep this in lock-step with the `clipId`
 * consumers: {@link SampledImage}, image fills in {@link FillRect}, and inside-
 * aligned strokes in {@link Strokes}.
 */
function usesClip(node: SceneNode): boolean {
  if (sampleVisible(node)) return true;
  if (node.fills.some((f) => f.visible && f.type === "image" && f.src))
    return true;
  return node.strokes.some(
    (s) => s.visible && s.width > 0 && s.align === "inside"
  );
}

/**
 * Re-samples the capture's base image inside a Blur/Magnifier region, clipped
 * to the region shape. Blur uses a `feGaussianBlur` scoped to the region;
 * Magnifier scales the image about the region center. Drawn the same way the
 * normal image fill is (cover), so it aligns with the image beneath. Kept in
 * sync with `lib/render.ts`'s `drawSample` — see ADR 0010.
 */
function SampledImage({
  node,
  nodes,
  clipId,
}: {
  node: SceneNode;
  nodes: Record<string, SceneNode>;
  clipId: string;
}) {
  const uid = useId();
  const base = findBaseImage(nodes);
  const sample = node.sample;
  if (!base || !sample) return null;
  const { src, rect: d } = base;
  const clip = `url(#${clipId})`;

  if (sample.mode === "magnify") {
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    const z = Math.max(1, sample.amount);
    // Clip on an *untransformed* group and scale the image inside it. Putting the
    // clip on the scaled <image> would scale the clip too, so the loupe bled past
    // its shape by the zoom factor. The Canvas2D export already clips-then-scales
    // (`drawSample`); this matches it. See ADR 0015.
    return (
      <g clipPath={clip}>
        <image
          href={src}
          x={d.x}
          y={d.y}
          width={d.width}
          height={d.height}
          preserveAspectRatio="xMidYMid slice"
          transform={`translate(${cx} ${cy}) scale(${z}) translate(${-cx} ${-cy})`}
        />
      </g>
    );
  }

  if (sample.mode === "pixelate") {
    return (
      <PixelatedImage
        node={node}
        base={base}
        cell={sample.amount}
        clip={clip}
      />
    );
  }

  // blur
  const r = Math.max(0, sample.amount);
  const blurId = `blur-${uid}`;
  return (
    <>
      <filter
        id={blurId}
        filterUnits="userSpaceOnUse"
        x={node.x - r}
        y={node.y - r}
        width={node.width + 2 * r}
        height={node.height + 2 * r}
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur stdDeviation={r} />
      </filter>
      <image
        href={src}
        x={d.x}
        y={d.y}
        width={d.width}
        height={d.height}
        preserveAspectRatio="xMidYMid slice"
        clipPath={clip}
        filter={`url(#${blurId})`}
      />
    </>
  );
}

/**
 * Pixelate region (live view). SVG has no reliable native mosaic filter, so we
 * rasterise the mosaic on an offscreen canvas (shared `pixelateRegion`, same as
 * the export) and show it as an `<image>`. While the first mosaic computes we
 * paint a neutral block — never the original pixels — so sensitive content is
 * never briefly revealed. On resize/cell change the previous mosaic stays up
 * (still obscured) until the new one is ready, avoiding a flicker.
 */
function PixelatedImage({
  node,
  base,
  cell,
  clip,
}: {
  node: SceneNode;
  base: BaseImage;
  cell: number;
  clip: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  // Depend on the primitive fields (not the node/base objects) so the mosaic is
  // only recomputed when geometry actually changes — and exhaustive-deps is happy.
  const { x, y, width, height } = node;
  const { src } = base;
  const { x: rx, y: ry, width: rw, height: rh } = base.rect;

  useEffect(() => {
    let live = true;
    loadImage(src)
      .then((img) => {
        if (!live) return;
        const canvas = pixelateRegion(
          img,
          { x: rx, y: ry, width: rw, height: rh },
          { x, y, width, height },
          cell
        );
        if (canvas) setUrl(canvas.toDataURL());
      })
      .catch(() => {
        /* base failed to decode; keep the placeholder */
      });
    return () => {
      live = false;
    };
  }, [src, rx, ry, rw, rh, x, y, width, height, cell]);

  if (!url) {
    return (
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill="#8b8f96"
        clipPath={clip}
      />
    );
  }
  return (
    <image
      href={url}
      x={x}
      y={y}
      width={width}
      height={height}
      preserveAspectRatio="none"
      clipPath={clip}
    />
  );
}

/**
 * The spotlight scrim: the page dimmed with this node's shape punched out. One
 * even-odd `<path>` from the shared module — the page rect concatenated with the
 * node's hole — filled the same way `render.ts`'s `Path2D` is, so the live SVG
 * and the export can't diverge (ADR 0023). Drawn in place of the node's fills,
 * so it covers everything painted earlier in z-order and the hole reveals it.
 */
function SpotlightScrim({
  node,
  nodes,
}: {
  node: SceneNode;
  nodes: Record<string, SceneNode>;
}) {
  const scrim = spotlightScrim(node, nodes);
  if (!scrim) return null;
  return (
    <path
      d={scrim.d}
      fill={scrim.color}
      fillOpacity={scrim.opacity}
      fillRule="evenodd"
    />
  );
}

function FrameView({
  node,
  nodes,
}: {
  node: FrameNode;
  nodes: Record<string, SceneNode>;
}) {
  const uid = useId();
  const clipId = `clip-${uid}`;
  const filterId = `fx-${uid}`;
  const d = cornerPath(node);
  const withFx = hasEffects(node);
  const clip = node.clipContent || usesClip(node);
  return (
    <>
      {(withFx || clip) && (
        <defs>
          {withFx && <EffectsDefs node={node} filterId={filterId} />}
          {clip && (
            <clipPath id={clipId}>
              <path d={d} />
            </clipPath>
          )}
        </defs>
      )}
      <g filter={withFx ? `url(#${filterId})` : undefined}>
        <Fills node={node} d={d} clipId={clipId} />
        <g clipPath={node.clipContent ? `url(#${clipId})` : undefined}>
          {node.children.map((id) => {
            const child = nodes[id];
            return child ? (
              <SceneNodeView key={id} node={child} nodes={nodes} />
            ) : null;
          })}
        </g>
        <ChromeBar node={node} />
        <Strokes node={node} d={d} clipId={clipId} />
      </g>
    </>
  );
}

/**
 * A stamp: the bundled glyph fit into the node's box, painted from the two path
 * strings `lib/stamps.ts` computes. This and `render.ts`'s `drawStamp` fill and
 * stroke the *same* `d`, so — like the spotlight scrim (ADR 0023) — there is no
 * per-renderer drawing left to drift.
 *
 * Paint order is halo (the node's strokes, widened underneath) then ink (its
 * solid fills), and within each: the areal sub-paths, then the linear ones at
 * the icon's own weight. Gradient/image fills sit out, as they do on every other
 * outline view here.
 */
function StampMark({ node }: { node: RectangleNode }) {
  const geo = stampGeometry(node);
  if (!geo) return null;
  return (
    <g>
      {node.strokes.map((s) =>
        s.visible && s.width > 0 ? (
          <g key={s.id}>
            {geo.fillD && (
              <path
                d={geo.fillD}
                fillRule="evenodd"
                fill={rgba(s.color, s.opacity)}
                stroke={rgba(s.color, s.opacity)}
                strokeWidth={stampOutlineWeight(s.width)}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            {geo.strokeD && (
              <path
                d={geo.strokeD}
                fill="none"
                stroke={rgba(s.color, s.opacity)}
                strokeWidth={stampHaloWeight(geo, s.width)}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </g>
        ) : null
      )}
      {node.fills.map((f) =>
        f.visible && f.type === "solid" ? (
          <g key={f.id}>
            {geo.fillD && (
              <path
                d={geo.fillD}
                fillRule="evenodd"
                fill={rgba(f.color, f.opacity)}
              />
            )}
            {geo.strokeD && (
              <path
                d={geo.strokeD}
                fill="none"
                stroke={rgba(f.color, f.opacity)}
                strokeWidth={geo.weight}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </g>
        ) : null
      )}
    </g>
  );
}

function RectView({
  node,
  nodes,
}: {
  node: RectangleNode | ImageNode;
  nodes: Record<string, SceneNode>;
}) {
  const uid = useId();
  const clipId = `clip-${uid}`;
  const filterId = `fx-${uid}`;
  const d = cornerPath(node);
  const withFx = hasEffects(node);
  const clip = usesClip(node);
  return (
    <>
      {(withFx || clip) && (
        <defs>
          {withFx && <EffectsDefs node={node} filterId={filterId} />}
          {clip && (
            <clipPath id={clipId}>
              <path d={d} />
            </clipPath>
          )}
        </defs>
      )}
      <g filter={withFx ? `url(#${filterId})` : undefined}>
        {sampleVisible(node) && (
          <SampledImage node={node} nodes={nodes} clipId={clipId} />
        )}
        <SpotlightScrim node={node} nodes={nodes} />
        <Fills node={node} d={d} clipId={clipId} />
        <ChromeBar node={node} />
        <Strokes node={node} d={d} clipId={clipId} />
      </g>
    </>
  );
}

function EllipseView({
  node,
  nodes,
}: {
  node: EllipseNode;
  nodes: Record<string, SceneNode>;
}) {
  const uid = useId();
  const clipId = `clip-${uid}`;
  const filterId = `fx-${uid}`;
  const withFx = hasEffects(node);
  const clip = usesClip(node);
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const rx = node.width / 2;
  const ry = node.height / 2;
  return (
    <>
      {(withFx || clip) && (
        <defs>
          {withFx && <EffectsDefs node={node} filterId={filterId} />}
          {clip && (
            <clipPath id={clipId}>
              <ellipse cx={cx} cy={cy} rx={rx} ry={ry} />
            </clipPath>
          )}
        </defs>
      )}
      <g filter={withFx ? `url(#${filterId})` : undefined}>
        {sampleVisible(node) && (
          <SampledImage node={node} nodes={nodes} clipId={clipId} />
        )}
        <SpotlightScrim node={node} nodes={nodes} />
        {node.fills.map((f) =>
          f.visible && f.type === "solid" ? (
            <ellipse
              key={f.id}
              cx={cx}
              cy={cy}
              rx={rx}
              ry={ry}
              fill={rgba(f.color, f.opacity)}
            />
          ) : null
        )}
        {node.strokes.map((s) =>
          s.visible && s.width > 0 ? (
            <ellipse
              key={s.id}
              cx={cx}
              cy={cy}
              rx={rx}
              ry={ry}
              fill="none"
              stroke={rgba(s.color, s.opacity)}
              strokeWidth={strokeWidth(s)}
              clipPath={s.align === "inside" ? `url(#${clipId})` : undefined}
            />
          ) : null
        )}
        {node.step ? (
          <text
            x={cx}
            y={cy}
            fill="#ffffff"
            fontSize={Math.min(node.width, node.height) * 0.6}
            fontWeight={700}
            fontFamily='"Inter", system-ui, sans-serif'
            textAnchor="middle"
            dominantBaseline="central"
            style={{ userSelect: "none" }}
          >
            {node.step.number}
          </text>
        ) : null}
      </g>
    </>
  );
}

function TextView({ node }: { node: TextNode }) {
  const anchor =
    node.align === "center"
      ? "middle"
      : node.align === "right"
        ? "end"
        : "start";
  const anchorX =
    node.align === "center"
      ? node.x + node.width / 2
      : node.align === "right"
        ? node.x + node.width
        : node.x;
  const lineH = node.fontSize * node.lineHeight;
  const lines = node.text.split("\n");
  return (
    <text
      x={anchorX}
      y={node.y}
      fill={node.color}
      fontSize={node.fontSize}
      fontWeight={node.fontWeight}
      fontFamily='"Inter", system-ui, sans-serif'
      textAnchor={anchor}
      dominantBaseline="hanging"
      letterSpacing={node.letterSpacing}
      style={{ whiteSpace: "pre" }}
    >
      {lines.map((line, i) => (
        <tspan key={i} x={anchorX} y={node.y + i * lineH}>
          {line || " "}
        </tspan>
      ))}
    </text>
  );
}

/**
 * A dimension line: shaft (broken around the label), end caps, and the length
 * label pill. Every number comes from `lib/measure.ts`, so this and `render.ts`'s
 * `drawMeasure` are two spellings of one drawing rather than two implementations
 * to keep in agreement — the contract `ChromeBar` and the spotlight scrim
 * already hold (ADR 0022/0023).
 *
 * The stroke's opacity is applied to the group so the shaft, caps, and label
 * fade as one mark; the Canvas2D side multiplies it into `globalAlpha`.
 */
function MeasureMarks({ node }: { node: LineNode | ArrowNode }) {
  const geo = measureGeometry(node);
  if (!geo) return null;
  const { label } = geo;
  const segments = [...geo.shaft, ...geo.ticks];
  return (
    <g opacity={geo.opacity}>
      {segments.map(([p, q], i) => (
        <line
          key={i}
          x1={p.x}
          y1={p.y}
          x2={q.x}
          y2={q.y}
          stroke={geo.color}
          strokeWidth={geo.width}
          strokeLinecap="butt"
        />
      ))}
      {geo.heads.map((points, i) => (
        <polygon key={i} points={pointsAttr(points)} fill={geo.color} />
      ))}
      <g transform={`rotate(${label.rotation} ${label.cx} ${label.cy})`}>
        <rect
          x={label.cx - label.width / 2}
          y={label.cy - label.height / 2}
          width={label.width}
          height={label.height}
          rx={label.radius}
          ry={label.radius}
          fill={label.plate}
        />
        <text
          x={label.cx}
          y={label.cy}
          fill={label.color}
          fontSize={label.size}
          fontWeight={600}
          fontFamily='"Inter", system-ui, sans-serif'
          textAnchor="middle"
          dominantBaseline="central"
          style={{ userSelect: "none" }}
        >
          {label.text}
        </text>
      </g>
    </g>
  );
}

function LineView({ node }: { node: LineNode | ArrowNode }) {
  // A dimension replaces the plain shaft entirely — its own shaft is broken
  // around the label and inset for the caps (`lib/measure.ts`).
  if (node.measure) return <MeasureMarks node={node} />;
  const { a, b } = lineEndpoints(node);
  const stroke =
    node.strokes.find((s) => s.visible && s.width > 0) ?? node.strokes[0];
  if (!stroke) return null;
  const color = rgba(stroke.color, stroke.opacity);
  const headLen = Math.max(8, stroke.width * 3.2);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const spread = 0.5;
  const isArrow = node.type === "arrow";
  // End the shaft at the arrowhead's base so its round cap doesn't poke past
  // the sharp tip (capped at the line length so short arrows don't reverse).
  const lineLen = Math.hypot(b.x - a.x, b.y - a.y);
  const baseDist = isArrow ? Math.min(headLen * Math.cos(spread), lineLen) : 0;
  const ex = b.x - baseDist * Math.cos(angle);
  const ey = b.y - baseDist * Math.sin(angle);
  return (
    <g>
      <line
        x1={a.x}
        y1={a.y}
        x2={ex}
        y2={ey}
        stroke={color}
        strokeWidth={stroke.width}
        strokeLinecap="round"
      />
      {isArrow && (
        <polygon
          points={[
            `${b.x},${b.y}`,
            `${b.x - headLen * Math.cos(angle - spread)},${b.y - headLen * Math.sin(angle - spread)}`,
            `${b.x - headLen * Math.cos(angle + spread)},${b.y - headLen * Math.sin(angle + spread)}`,
          ].join(" ")}
          fill={color}
        />
      )}
    </g>
  );
}

function strokeWidth(s: Stroke): number {
  // Inside/outside are emulated by doubling + clipping; center is exact.
  return s.align === "center" ? s.width : s.width * 2;
}

function Fills({
  node,
  d,
  clipId,
}: {
  node: FrameNode | RectangleNode | ImageNode;
  d: string;
  clipId: string;
}) {
  return (
    <>
      {node.fills.map((f) => (
        <FillRect key={f.id} fill={f} node={node} d={d} clipId={clipId} />
      ))}
    </>
  );
}

function FillRect({
  fill,
  node,
  d,
  clipId,
}: {
  fill: Paint;
  node: FrameNode | RectangleNode | ImageNode;
  d: string;
  clipId: string;
}) {
  if (!fill.visible) return null;
  let content: ReactNode = null;
  if (fill.type === "image" && fill.src) {
    content = (
      <image
        href={fill.src}
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        preserveAspectRatio={imagePreserveAspectRatio(
          fill.imageScale ?? "fill",
          fill.imageAlign ?? "center"
        )}
        clipPath={`url(#${clipId})`}
        opacity={fill.opacity}
      />
    );
  } else if (fill.type === "gradient" && fill.gradient) {
    content = (
      <GradientFill
        gradient={fill.gradient}
        opacity={fill.opacity}
        d={d}
        node={node}
      />
    );
  } else if (fill.type === "solid") {
    content = <path d={d} fill={rgba(fill.color, fill.opacity)} />;
  }
  if (content && fill.blendMode && fill.blendMode !== "normal") {
    // Per-fill blend composites with the fills + backdrop painted before it.
    return <g style={{ mixBlendMode: fill.blendMode }}>{content}</g>;
  }
  return content;
}

function GradientFill({
  gradient,
  opacity,
  d,
  node,
}: {
  gradient: GradientPaint;
  opacity: number;
  d: string;
  node: FrameNode | RectangleNode | ImageNode;
}) {
  const gid = useId();
  if (gradient.kind === "freeform") {
    return (
      <RasterGradientImage
        render={renderFreeform}
        gradient={gradient}
        opacity={opacity}
        d={d}
        node={node}
      />
    );
  }
  if (gradient.kind === "mesh") {
    return (
      <RasterGradientImage
        render={renderMesh}
        gradient={gradient}
        opacity={opacity}
        d={d}
        node={node}
      />
    );
  }
  const stops = [...gradient.stops].sort((a, b) => a.position - b.position);
  const ramp = stops.map((s) => (
    <stop
      key={s.id}
      offset={`${s.position * 100}%`}
      stopColor={s.color}
      stopOpacity={s.opacity}
    />
  ));
  const geo = gradientGeometry(gradient);
  // Geometry is kept in lock-step with `render.ts`'s Canvas2D path (see G1):
  // linear + ellipse-radial use objectBoundingBox fractions; a true circle uses
  // user-space px so the box aspect doesn't stretch it into an ellipse.
  let def;
  if (gradient.kind === "radial") {
    if (geo.shape === "circle") {
      const cx = node.x + geo.center.x * node.width;
      const cy = node.y + geo.center.y * node.height;
      const r = geo.radius * node.width;
      def = (
        <radialGradient
          id={gid}
          gradientUnits="userSpaceOnUse"
          cx={cx}
          cy={cy}
          r={r}
          fx={node.x + geo.focal.x * node.width}
          fy={node.y + geo.focal.y * node.height}
        >
          {ramp}
        </radialGradient>
      );
    } else {
      def = (
        <radialGradient
          id={gid}
          cx={geo.center.x}
          cy={geo.center.y}
          r={geo.radius}
          fx={geo.focal.x}
          fy={geo.focal.y}
        >
          {ramp}
        </radialGradient>
      );
    }
  } else {
    def = (
      <linearGradient
        id={gid}
        x1={geo.start.x}
        y1={geo.start.y}
        x2={geo.end.x}
        y2={geo.end.y}
      >
        {ramp}
      </linearGradient>
    );
  }
  return (
    <>
      <defs>{def}</defs>
      <path d={d} fill={`url(#${gid})`} opacity={opacity} />
    </>
  );
}

/**
 * Raster gradient (live view) — freeform or mesh, which have no SVG primitive.
 * The supplied `render` rasterizes to an offscreen canvas (the same fn the export
 * uses), shown as an `<image>` clipped to the shape. The capped-resolution bitmap
 * is upscaled by `preserveAspectRatio="none"`; the blend is smooth so it's clean.
 */
function RasterGradientImage({
  gradient,
  opacity,
  d,
  node,
  render,
}: {
  gradient: GradientPaint;
  opacity: number;
  d: string;
  node: FrameNode | RectangleNode | ImageNode;
  render: (g: GradientPaint, w: number, h: number) => HTMLCanvasElement | null;
}) {
  const cid = useId();
  const url = useMemo(() => {
    const canvas = render(gradient, node.width, node.height);
    return canvas ? canvas.toDataURL() : null;
  }, [render, gradient, node.width, node.height]);
  if (!url) return null;
  return (
    <>
      <defs>
        <clipPath id={cid}>
          <path d={d} />
        </clipPath>
      </defs>
      <image
        href={url}
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        preserveAspectRatio="none"
        clipPath={`url(#${cid})`}
        opacity={opacity}
      />
    </>
  );
}

function Strokes({
  node,
  d,
  clipId,
}: {
  node: FrameNode | RectangleNode | ImageNode;
  d: string;
  clipId: string;
}) {
  return (
    <>
      {node.strokes.map((s) =>
        s.visible && s.width > 0 ? (
          <path
            key={s.id}
            d={d}
            fill="none"
            stroke={rgba(s.color, s.opacity)}
            strokeWidth={strokeWidth(s)}
            clipPath={s.align === "inside" ? `url(#${clipId})` : undefined}
          />
        ) : null
      )}
    </>
  );
}
