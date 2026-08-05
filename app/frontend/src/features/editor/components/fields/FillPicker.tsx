import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Blend,
  ChevronDown,
  Image as ImageIcon,
  Minus,
  Plus,
  Square,
} from "lucide-react";

import { cn } from "@shared/lib/cn";
import { Select } from "@shared/ui";

import { gradientCss, rgba } from "../../lib/paint";
import { useEditorStore } from "../../state/editorStore";
import {
  makeFreeformLine,
  makeFreeformPoints,
  makeGradientPaint,
  makeMesh,
  nextNodeId,
  resizeMesh,
  type BlendMode,
  type FreeformMode,
  type FreeformStop,
  type GradientKind,
  type GradientPaint,
  type GradientShape,
  type ImageAlign,
  type ImageScale,
  type MeshSpec,
  type Paint,
  type PaintType,
} from "../../types";
import { SELECT_TRIGGER_FULL } from "./chrome";
import { ColorPicker } from "./ColorPicker";
import { NumberField } from "./NumberField";

interface FillPickerProps {
  paint: Paint;
  onChange: (patch: Partial<Paint>) => void;
  /** Open the OS file picker to choose an image source for this fill. */
  onPickImage: () => void;
  /** Drop the standalone card chrome when hosted in the floating popover. */
  bare?: boolean;
}

const TYPES: readonly {
  type: PaintType;
  Icon: typeof Square;
  label: string;
}[] = [
  { type: "solid", Icon: Square, label: "Solid" },
  { type: "gradient", Icon: Blend, label: "Gradient" },
  { type: "image", Icon: ImageIcon, label: "Image" },
];

const BLEND_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "multiply", label: "Multiply" },
  { value: "screen", label: "Screen" },
  { value: "overlay", label: "Overlay" },
  { value: "darken", label: "Darken" },
  { value: "lighten", label: "Lighten" },
  { value: "color-dodge", label: "Color dodge" },
  { value: "color-burn", label: "Color burn" },
  { value: "hard-light", label: "Hard light" },
  { value: "soft-light", label: "Soft light" },
  { value: "difference", label: "Difference" },
  { value: "exclusion", label: "Exclusion" },
] as const;

const CHECKER =
  "repeating-conic-gradient(#888 0% 25%, #bbb 0% 50%) 50% / 12px 12px";

const SCALE_OPTIONS = [
  { value: "fill", label: "Fill" },
  { value: "fit", label: "Fit" },
  { value: "stretch", label: "Stretch" },
] as const;

const ALIGN_OPTIONS = [
  { value: "center", label: "Center" },
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "top-left", label: "Top left" },
  { value: "top-right", label: "Top right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-right", label: "Bottom right" },
] as const;

const IMG_TRIGGER = SELECT_TRIGGER_FULL;
const IMG_LABEL = "mb-1 text-[11px] text-[var(--ed-text-dim)]";

/**
 * Inline fill editor: pick the paint type (solid / gradient / image) and edit
 * it. Solid + gradient stops share the HSV {@link ColorPicker}. Pattern fills
 * are intentionally not offered yet.
 */
export function FillPicker({
  paint,
  onChange,
  onPickImage,
  bare = false,
}: FillPickerProps) {
  const setType = (type: PaintType): void => {
    if (type === paint.type) return;
    if (type === "gradient") {
      onChange({
        type: "gradient",
        gradient: paint.gradient ?? makeGradientPaint(paint.color).gradient,
      });
    } else if (type === "image") {
      onChange({ type: "image" });
      if (!paint.src) onPickImage();
    } else {
      onChange({ type: "solid" });
    }
  };

  return (
    <div
      className={
        bare
          ? "p-2"
          : "mt-1.5 rounded-[8px] border border-[color:var(--ed-hairline)] bg-[var(--ed-elev)] p-2"
      }
    >
      {/* Shared header: fill-mode icons (left), blend mode + opacity (right). */}
      <div className="mb-2.5 flex items-center gap-1.5">
        <div className="flex items-center gap-0.5">
          {TYPES.map(({ type, Icon, label }) => (
            <button
              key={type}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={paint.type === type}
              onClick={() => setType(type)}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-[6px]",
                paint.type === type
                  ? "bg-[var(--ed-accent-soft)] text-[var(--ed-accent)]"
                  : "text-[var(--ed-text-dim)] hover:bg-[var(--ed-input-bg)] hover:text-[var(--ed-text)]"
              )}
            >
              <Icon size={15} strokeWidth={1.75} />
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <Select
            ariaLabel="Blend mode"
            value={paint.blendMode ?? "normal"}
            options={BLEND_OPTIONS}
            onChange={(v) => onChange({ blendMode: v as BlendMode })}
            triggerClassName={SELECT_TRIGGER_FULL}
          />
        </div>
        <div className="w-12 shrink-0">
          <NumberField
            suffix="%"
            min={0}
            max={100}
            value={Math.round(paint.opacity * 100)}
            onChange={(v) => onChange({ opacity: v / 100 })}
          />
        </div>
      </div>

      {paint.type === "solid" && (
        <ColorPicker
          color={paint.color}
          opacity={paint.opacity}
          onChange={(color, opacity) => onChange({ color, opacity })}
        />
      )}

      {paint.type === "gradient" && paint.gradient && (
        <GradientBody
          gradient={paint.gradient}
          onChange={(gradient) => onChange({ gradient })}
        />
      )}

      {paint.type === "image" && (
        <div className="flex flex-col gap-2">
          {paint.src ? (
            <img
              src={paint.src}
              alt=""
              className="h-24 w-full rounded-[6px] object-contain"
              style={{ background: CHECKER }}
            />
          ) : (
            <div
              className="flex h-24 w-full items-center justify-center rounded-[6px] text-[12px] text-[var(--ed-text-dim)]"
              style={{ background: CHECKER }}
            >
              No image
            </div>
          )}
          <button
            type="button"
            onClick={onPickImage}
            className="flex h-7 w-full items-center justify-center rounded-[6px] bg-[var(--ed-input-bg)] text-[12px] text-[var(--ed-text)] hover:bg-[var(--ed-input-bg-hover)]"
          >
            {paint.src ? "Replace image" : "Select source…"}
          </button>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className={IMG_LABEL}>Scale</p>
              <Select
                ariaLabel="Image scale"
                value={paint.imageScale ?? "fill"}
                options={SCALE_OPTIONS}
                onChange={(v) => onChange({ imageScale: v as ImageScale })}
                triggerClassName={IMG_TRIGGER}
              />
            </div>
            <div>
              <p className={IMG_LABEL}>Position</p>
              <Select
                ariaLabel="Image position"
                value={paint.imageAlign ?? "center"}
                options={ALIGN_OPTIONS}
                onChange={(v) => onChange({ imageAlign: v as ImageAlign })}
                triggerClassName={IMG_TRIGGER}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const KIND_OPTIONS = [
  { value: "linear", label: "Linear" },
  { value: "radial", label: "Radial" },
  { value: "freeform", label: "Freeform" },
  { value: "mesh", label: "Mesh" },
] as const;

const SHAPE_OPTIONS = [
  { value: "ellipse", label: "Ellipse" },
  { value: "circle", label: "Circle" },
] as const;

/** Compact 0–100% field for a gradient stop's position / opacity (0..1 model). */
function StopPercent({
  ariaLabel,
  value,
  onChange,
}: {
  ariaLabel: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex h-7 w-12 shrink-0 items-center rounded-[6px] bg-[var(--ed-input-bg)] px-1.5">
      <input
        type="number"
        aria-label={ariaLabel}
        min={0}
        max={100}
        value={Math.round(value * 100)}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.max(0, Math.min(1, v / 100)));
        }}
        className="min-w-0 flex-1 bg-transparent text-[12px] tabular-nums text-[var(--ed-text)] outline-none"
      />
      <span className="pl-0.5 text-[11px] text-[var(--ed-text-dim)]">%</span>
    </div>
  );
}

/**
 * Interactive gradient track (Workstream FE3): the stop ramp with a draggable
 * handle per stop. Drag a handle to reposition it, press the track to add a stop
 * there, press a handle to select it. A drag coalesces to one undo step via the
 * store's history transaction.
 */
function GradientBar({
  gradient,
  activeId,
  onChange,
  onSelectStop,
  onAddStop,
}: {
  gradient: GradientPaint;
  activeId: string;
  onChange: (g: GradientPaint) => void;
  onSelectStop: (id: string) => void;
  onAddStop: (position: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);

  const posFromClientX = (clientX: number): number => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const onHandleDown = (e: ReactPointerEvent, id: string): void => {
    e.stopPropagation();
    onSelectStop(id);
    dragId.current = id;
    useEditorStore.getState().beginHistory();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: ReactPointerEvent): void => {
    if (!dragId.current) return;
    const position = posFromClientX(e.clientX);
    onChange({
      ...gradient,
      stops: gradient.stops.map((s) =>
        s.id === dragId.current ? { ...s, position } : s
      ),
    });
  };
  const onHandleUp = (): void => {
    if (!dragId.current) return;
    dragId.current = null;
    useEditorStore.getState().endHistory();
  };

  return (
    <div className="relative h-8 select-none">
      <div
        ref={trackRef}
        role="button"
        aria-label="Gradient track"
        onPointerDown={(e) => onAddStop(posFromClientX(e.clientX))}
        className="h-full w-full rounded-[4px] border border-[color:var(--ed-hairline)]"
        style={{
          background: gradientCss({ ...gradient, kind: "linear", angle: 0 }),
        }}
      />
      {gradient.stops.map((s) => (
        <button
          key={s.id}
          type="button"
          aria-label="Gradient stop handle"
          onPointerDown={(e) => onHandleDown(e, s.id)}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          className={cn(
            "absolute bottom-[-3px] h-3.5 w-3.5 -translate-x-1/2 rounded-[3px] border-2 shadow",
            s.id === activeId ? "border-[var(--ed-accent)]" : "border-white"
          )}
          style={{
            left: `${s.position * 100}%`,
            background: rgba(s.color, s.opacity),
          }}
        />
      ))}
    </div>
  );
}

function GradientBody({
  gradient,
  onChange,
}: {
  gradient: GradientPaint;
  onChange: (g: GradientPaint) => void;
}) {
  const ordered = [...gradient.stops].sort((a, b) => a.position - b.position);
  const [activeId, setActiveId] = useState<string>(ordered[0]!.id);
  const active = gradient.stops.find((s) => s.id === activeId) ?? ordered[0]!;
  // Which stop's color picker is expanded (Figma hides the picker until asked).
  const [colorOpenId, setColorOpenId] = useState<string | null>(null);

  const patchStop = (
    sid: string,
    patch: Partial<(typeof gradient.stops)[number]>
  ): void =>
    onChange({
      ...gradient,
      stops: gradient.stops.map((s) => (s.id === sid ? { ...s, ...patch } : s)),
    });

  const addStop = (position = 0.5): void => {
    const id = nextNodeId("stop");
    onChange({
      ...gradient,
      stops: [
        ...gradient.stops,
        {
          id,
          position: Math.max(0, Math.min(1, position)),
          color: active.color,
          opacity: active.opacity,
        },
      ],
    });
    setActiveId(id);
  };

  const removeStop = (sid: string): void => {
    if (gradient.stops.length <= 2) return;
    onChange({
      ...gradient,
      stops: gradient.stops.filter((s) => s.id !== sid),
    });
    if (activeId === sid) setActiveId(ordered.find((s) => s.id !== sid)!.id);
  };

  return (
    <div className="flex flex-col gap-2.5">
      {/* Control row: gradient type (left) + angle (linear) / shape (radial). */}
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <Select
            ariaLabel="Gradient type"
            value={gradient.kind}
            options={KIND_OPTIONS}
            onChange={(v) => {
              const kind = v as GradientKind;
              onChange(
                kind === "freeform"
                  ? {
                      ...gradient,
                      kind,
                      points: gradient.points ?? makeFreeformPoints(),
                    }
                  : kind === "mesh"
                    ? { ...gradient, kind, mesh: gradient.mesh ?? makeMesh() }
                    : { ...gradient, kind }
              );
            }}
            triggerClassName={SELECT_TRIGGER_FULL}
          />
        </div>
        {gradient.kind === "linear" && (
          <div className="flex h-7 w-16 shrink-0 items-center rounded-[6px] bg-[var(--ed-input-bg)] px-2">
            <input
              type="number"
              aria-label="Gradient angle"
              value={Math.round(gradient.angle)}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) onChange({ ...gradient, angle: v });
              }}
              className="min-w-0 flex-1 bg-transparent text-right text-[12px] tabular-nums text-[var(--ed-text)] outline-none"
            />
            <span className="pl-0.5 text-[12px] text-[var(--ed-text-dim)]">
              °
            </span>
          </div>
        )}
        {gradient.kind === "radial" && (
          <div className="w-24 shrink-0">
            <Select
              ariaLabel="Radial shape"
              value={gradient.shape ?? "ellipse"}
              options={SHAPE_OPTIONS}
              onChange={(v) =>
                onChange({ ...gradient, shape: v as GradientShape })
              }
              triggerClassName={SELECT_TRIGGER_FULL}
            />
          </div>
        )}
      </div>

      {gradient.kind === "freeform" ? (
        <FreeformBody gradient={gradient} onChange={onChange} />
      ) : gradient.kind === "mesh" ? (
        <MeshBody gradient={gradient} onChange={onChange} />
      ) : (
        <>
          <GradientBar
            gradient={gradient}
            activeId={active.id}
            onChange={onChange}
            onSelectStop={setActiveId}
            onAddStop={addStop}
          />

          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[var(--ed-text-dim)]">Stops</span>
            <button
              type="button"
              title="Add stop"
              aria-label="Add stop"
              onClick={() => addStop()}
              className="flex h-5 w-5 items-center justify-center rounded-[4px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-input-bg)] hover:text-[var(--ed-text)]"
            >
              <Plus size={14} strokeWidth={2} />
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {ordered.map((s) => (
              <div key={s.id} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <StopPercent
                    ariaLabel="Stop position"
                    value={s.position}
                    onChange={(position) => patchStop(s.id, { position })}
                  />
                  <button
                    type="button"
                    aria-label="Stop color"
                    onClick={() => {
                      setActiveId(s.id);
                      setColorOpenId((id) => (id === s.id ? null : s.id));
                    }}
                    className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[6px] bg-[var(--ed-input-bg)] px-1.5 hover:bg-[var(--ed-input-bg-hover)]"
                  >
                    <span
                      className="h-4 w-4 shrink-0 rounded-[3px] border border-[color:var(--ed-hairline)]"
                      style={{ background: rgba(s.color, s.opacity) }}
                    />
                    <span className="flex-1 truncate text-left text-[12px] uppercase text-[var(--ed-text)]">
                      {s.color.replace(/^#/, "")}
                    </span>
                    <ChevronDown
                      size={12}
                      className="shrink-0 text-[var(--ed-text-dim)]"
                    />
                  </button>
                  <StopPercent
                    ariaLabel="Stop opacity"
                    value={s.opacity}
                    onChange={(opacity) => patchStop(s.id, { opacity })}
                  />
                  <button
                    type="button"
                    title="Remove stop"
                    aria-label="Remove stop"
                    disabled={gradient.stops.length <= 2}
                    onClick={() => removeStop(s.id)}
                    className="flex h-7 w-6 shrink-0 items-center justify-center rounded-[5px] text-[var(--ed-text-dim)] hover:text-[var(--ed-danger)] disabled:opacity-30"
                  >
                    <Minus size={13} strokeWidth={2} />
                  </button>
                </div>
                {colorOpenId === s.id && (
                  <ColorPicker
                    color={s.color}
                    opacity={s.opacity}
                    onChange={(color, opacity) =>
                      patchStop(s.id, { color, opacity })
                    }
                  />
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Mesh-gradient editor: a rows×cols grid of color cells (click to recolor) plus
 *  row/column steppers. Uniform grid, bilinear (Workstream G4). */
function MeshBody({
  gradient,
  onChange,
}: {
  gradient: GradientPaint;
  onChange: (g: GradientPaint) => void;
}) {
  const mesh = gradient.mesh ?? makeMesh();
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const setMesh = (m: MeshSpec): void => onChange({ ...gradient, mesh: m });
  const patchCell = (
    idx: number,
    patch: Partial<MeshSpec["points"][number]>
  ): void =>
    setMesh({
      ...mesh,
      points: mesh.points.map((p, k) => (k === idx ? { ...p, ...patch } : p)),
    });
  const resize = (rows: number, cols: number): void => {
    setMesh(resizeMesh(mesh, rows, cols));
    setOpenIdx(null);
  };

  const open = openIdx !== null ? mesh.points[openIdx] : undefined;
  const sizeField =
    "h-7 w-full rounded-[6px] bg-[var(--ed-input-bg)] px-2 text-[12px] tabular-nums text-[var(--ed-text)] outline-none";

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className={IMG_LABEL}>Rows</p>
          <input
            type="number"
            aria-label="Mesh rows"
            min={1}
            max={8}
            value={mesh.rows}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) resize(v, mesh.cols);
            }}
            className={sizeField}
          />
        </div>
        <div>
          <p className={IMG_LABEL}>Columns</p>
          <input
            type="number"
            aria-label="Mesh columns"
            min={1}
            max={8}
            value={mesh.cols}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) resize(mesh.rows, v);
            }}
            className={sizeField}
          />
        </div>
      </div>
      <p className="text-[11px] text-[var(--ed-text-dim)]">
        Click a cell to recolor it.
      </p>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${mesh.cols}, minmax(0, 1fr))` }}
      >
        {mesh.points.map((p, idx) => (
          <button
            key={idx}
            type="button"
            aria-label="Mesh cell"
            onClick={() => setOpenIdx((i) => (i === idx ? null : idx))}
            className={cn(
              "h-7 rounded-[5px] border",
              idx === openIdx
                ? "border-[color:var(--ed-accent)] ring-1 ring-[var(--ed-accent)]"
                : "border-[color:var(--ed-hairline)]"
            )}
            style={{ background: rgba(p.color, p.opacity) }}
          />
        ))}
      </div>
      {openIdx !== null && open && (
        <ColorPicker
          color={open.color}
          opacity={open.opacity}
          onChange={(color, opacity) => patchCell(openIdx, { color, opacity })}
        />
      )}
    </div>
  );
}

const FREEFORM_MODES: readonly FreeformMode[] = ["points", "lines"];

/** Freeform-gradient editor: a Points/Lines sub-toggle, then a swatch per color
 *  stop (select to edit its color) plus add/remove. Positions are dragged on the
 *  canvas (Workstream G3). In `lines` mode the stops belong to the first line. */
function FreeformBody({
  gradient,
  onChange,
}: {
  gradient: GradientPaint;
  onChange: (g: GradientPaint) => void;
}) {
  const mode = gradient.freeformMode ?? "points";
  const line = gradient.lines?.[0];
  const stops =
    mode === "lines" ? (line?.stops ?? []) : (gradient.points ?? []);

  const [activeId, setActiveId] = useState<string>(stops[0]?.id ?? "");
  const active = stops.find((s) => s.id === activeId) ?? stops[0];

  const setMode = (m: FreeformMode): void =>
    onChange(
      m === "lines"
        ? {
            ...gradient,
            freeformMode: m,
            lines: gradient.lines?.length
              ? gradient.lines
              : [makeFreeformLine()],
          }
        : {
            ...gradient,
            freeformMode: m,
            points: gradient.points?.length
              ? gradient.points
              : makeFreeformPoints(),
          }
    );

  const writeStops = (next: FreeformStop[]): void =>
    onChange(
      mode === "lines"
        ? {
            ...gradient,
            lines: [
              { id: line?.id ?? nextNodeId("ln"), stops: next },
              ...(gradient.lines?.slice(1) ?? []),
            ],
          }
        : { ...gradient, points: next }
    );

  const patchStop = (sid: string, patch: Partial<FreeformStop>): void =>
    writeStops(stops.map((s) => (s.id === sid ? { ...s, ...patch } : s)));

  const addStop = (): void => {
    const id = nextNodeId("pt");
    const last = stops[stops.length - 1];
    // A line stop extends the path; a free point drops at the center.
    const point =
      mode === "lines" && last
        ? {
            x: Math.min(1, Math.max(0, last.point.x + 0.12)),
            y: Math.min(1, Math.max(0, last.point.y + 0.12)),
          }
        : { x: 0.5, y: 0.5 };
    writeStops([
      ...stops,
      {
        id,
        point,
        color: active?.color ?? "#ffffff",
        opacity: active?.opacity ?? 1,
      },
    ]);
    setActiveId(id);
  };

  const removeStop = (sid: string): void => {
    if (stops.length <= 2) return;
    writeStops(stops.filter((s) => s.id !== sid));
    if (activeId === sid) setActiveId(stops.find((s) => s.id !== sid)!.id);
  };

  const label = mode === "lines" ? "line stop" : "color point";

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex rounded-[6px] bg-[var(--ed-input-bg)] p-0.5">
        {FREEFORM_MODES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              "h-6 flex-1 rounded-[5px] text-[12px] capitalize",
              mode === m
                ? "bg-[var(--ed-elev-hover)] text-[var(--ed-text)]"
                : "text-[var(--ed-text-dim)] hover:text-[var(--ed-text)]"
            )}
          >
            {m}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-[var(--ed-text-dim)]">
        {mode === "lines"
          ? "Drag the line's stops on the canvas to shape it."
          : "Drag the points on the canvas to position them."}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {stops.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-label={`Select ${label}`}
            onClick={() => setActiveId(s.id)}
            className={cn(
              "h-6 w-6 rounded-[5px] border",
              s.id === active?.id
                ? "border-[color:var(--ed-accent)] ring-1 ring-[var(--ed-accent)]"
                : "border-[color:var(--ed-hairline)]"
            )}
            style={{ background: rgba(s.color, s.opacity) }}
          />
        ))}
        <button
          type="button"
          title={`Add ${label}`}
          aria-label={`Add ${label}`}
          onClick={addStop}
          className="flex h-6 w-6 items-center justify-center rounded-[5px] border border-dashed border-[color:var(--ed-hairline)] text-[var(--ed-text-dim)] hover:text-[var(--ed-text)]"
        >
          <Plus size={14} strokeWidth={2} />
        </button>
      </div>
      {active && (
        <>
          <ColorPicker
            color={active.color}
            opacity={active.opacity}
            onChange={(color, opacity) =>
              patchStop(active.id, { color, opacity })
            }
          />
          <button
            type="button"
            aria-label={`Remove ${label}`}
            disabled={stops.length <= 2}
            onClick={() => removeStop(active.id)}
            className="flex h-7 items-center justify-center gap-1 rounded-[6px] text-[12px] text-[var(--ed-text-dim)] hover:text-[var(--ed-danger)] disabled:opacity-30"
          >
            <Minus size={13} strokeWidth={2} /> Remove {label}
          </button>
        </>
      )}
    </div>
  );
}
