import {
  ArrowUpRight,
  Circle,
  Droplets,
  Grid3x3,
  Square,
  Trash2,
  Type,
} from "lucide-react";

import type { Annotation, AnnotationKind } from "@clippity/shared";
import { cn } from "@shared/lib/cn";

import { MIN_PIXELATE_BLOCK } from "../lib/redact";
import { useStudioStore } from "../state/studioStore";

/**
 * Add an annotation, and adjust the selected one.
 *
 * A single row rather than a side panel. Studio's layout is fixed —
 * picture, timeline, transport, export — and a panel that appeared on
 * selection would resize the picture underneath, moving the very thing
 * the user is pointing at.
 *
 * The controls shown depend on the selected kind, because the fields
 * genuinely differ: a spotlight has no colour and a blur has no text.
 * Only the fields that exist are offered, rather than greying out a
 * fixed set — a disabled control invites a click that will do nothing.
 */

/** The kinds, in the order they are offered. */
const KINDS: Array<{
  kind: AnnotationKind;
  icon: typeof Square;
  label: string;
}> = [
  { kind: "box", icon: Square, label: "Box" },
  { kind: "arrow", icon: ArrowUpRight, label: "Arrow" },
  { kind: "text", icon: Type, label: "Text" },
  { kind: "spotlight", icon: Circle, label: "Spotlight" },
  { kind: "blur", icon: Droplets, label: "Blur" },
  { kind: "pixelate", icon: Grid3x3, label: "Pixelate" },
];

/** Swatches offered for the drawn kinds. */
const COLORS = [
  "#ff3b30",
  "#ffcc00",
  "#34c759",
  "#0a84ff",
  "#ffffff",
  "#000000",
];

export function AnnotationInspector() {
  const info = useStudioStore((s) => s.info);
  const annotations = useStudioStore((s) => s.annotations);
  const selectedId = useStudioStore((s) => s.selectedAnnotationId);
  const addAnnotation = useStudioStore((s) => s.addAnnotation);
  const updateAnnotation = useStudioStore((s) => s.updateAnnotation);
  const removeAnnotation = useStudioStore((s) => s.removeAnnotation);

  if (!info) return null;
  const selected = annotations.find((a) => a.id === selectedId) ?? null;

  return (
    <div
      className="flex items-center gap-3 border-t px-6 py-2"
      style={{ borderColor: "var(--ed-hairline)" }}
    >
      <div
        className="flex items-center gap-0.5 rounded-[9px] p-0.5"
        style={{ background: "var(--ed-control-bg)" }}
      >
        {KINDS.map(({ kind, icon: Icon, label }) => (
          <button
            key={kind}
            type="button"
            title={`Add ${label.toLowerCase()}`}
            aria-label={`Add ${label.toLowerCase()}`}
            onClick={() => addAnnotation(kind)}
            className="focus-ring rounded-[7px] p-1.5 transition-colors hover:bg-[color:var(--ed-elev)]"
            style={{ color: "var(--ed-text-dim)" }}
          >
            <Icon size={15} strokeWidth={1.9} />
          </button>
        ))}
      </div>

      {selected ? (
        <>
          <div
            className="h-5 w-px"
            style={{ background: "var(--ed-hairline-strong)" }}
          />
          <SelectedControls
            annotation={selected}
            onChange={(patch) => updateAnnotation(selected.id, patch)}
          />
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => removeAnnotation(selected.id)}
            aria-label="Delete annotation"
            title="Delete annotation (Delete)"
            className="focus-ring rounded-[7px] p-1.5 transition-colors hover:bg-[color:var(--ed-elev)]"
            style={{ color: "var(--ed-danger)" }}
          >
            <Trash2 size={15} strokeWidth={1.9} />
          </button>
        </>
      ) : (
        <span
          className="text-[11.5px]"
          style={{ color: "var(--ed-text-faint)" }}
        >
          {annotations.length === 0
            ? "Add an annotation to mark up this recording."
            : "Select an annotation to edit it."}
        </span>
      )}
    </div>
  );
}

interface SelectedControlsProps {
  annotation: Annotation;
  onChange(patch: Partial<Annotation>): void;
}

/** The fields for whichever kind is selected. */
function SelectedControls({ annotation, onChange }: SelectedControlsProps) {
  switch (annotation.kind) {
    case "box":
      return (
        <>
          <Swatches
            value={annotation.color}
            onChange={(color) => onChange({ color })}
          />
          <Toggle
            label="Filled"
            // The redaction that actually redacts — a solid cover has no
            // recoverable signal under it, unlike a blur.
            title="A filled box is the safest redaction"
            checked={annotation.filled}
            onChange={(filled) => onChange({ filled })}
          />
        </>
      );

    case "arrow":
      return (
        <>
          <Swatches
            value={annotation.color}
            onChange={(color) => onChange({ color })}
          />
          <Toggle
            label="Flip"
            title="Point the arrow the other way along its diagonal"
            checked={annotation.fromCorner === "bottomRight"}
            onChange={(flipped) =>
              onChange({ fromCorner: flipped ? "bottomRight" : "topLeft" })
            }
          />
        </>
      );

    case "text":
      return (
        <>
          <input
            type="text"
            value={annotation.text}
            aria-label="Label text"
            onChange={(e) => onChange({ text: e.target.value })}
            className="focus-ring rounded-[7px] px-2 py-1 text-[12px]"
            style={{
              background: "var(--ed-control-bg)",
              color: "var(--ed-text)",
              border: "1px solid var(--ed-hairline-strong)",
              width: 180,
            }}
          />
          <Swatches
            value={annotation.color}
            onChange={(color) => onChange({ color })}
          />
          <Slider
            label="Size"
            // In fractions of the frame height, so a label keeps its
            // size relative to the picture at any export resolution.
            min={0.02}
            max={0.16}
            step={0.005}
            value={annotation.fontScale}
            onChange={(fontScale) => onChange({ fontScale })}
          />
        </>
      );

    case "spotlight":
      return (
        <Slider
          label="Dim"
          min={0.1}
          max={0.95}
          step={0.05}
          value={annotation.dim}
          onChange={(dim) => onChange({ dim })}
        />
      );

    case "blur":
      return (
        <Slider
          label="Strength"
          // Source pixels — the preview scales it to the stage, so what
          // is set here is what the export applies.
          min={2}
          max={40}
          step={1}
          value={annotation.radius}
          onChange={(radius) => onChange({ radius })}
        />
      );

    case "pixelate":
      return (
        <Slider
          label="Block"
          min={MIN_PIXELATE_BLOCK}
          max={64}
          step={1}
          value={annotation.block}
          onChange={(block) => onChange({ block })}
        />
      );
  }
}

interface SwatchesProps {
  value: string;
  onChange(color: string): void;
}

function Swatches({ value, onChange }: SwatchesProps) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Colour">
      {COLORS.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={color}
          aria-pressed={value.toLowerCase() === color}
          onClick={() => onChange(color)}
          className={cn(
            "focus-ring h-4.5 w-4.5 rounded-full transition-transform",
            value.toLowerCase() === color ? "scale-110" : ""
          )}
          style={{
            width: 18,
            height: 18,
            background: color,
            border:
              value.toLowerCase() === color
                ? "2px solid var(--ed-accent)"
                : "1px solid var(--ed-hairline-strong)",
          }}
        />
      ))}
    </div>
  );
}

interface SliderProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange(value: number): void;
}

function Slider({ label, min, max, step, value, onChange }: SliderProps) {
  return (
    <label
      className="flex items-center gap-1.5 text-[11.5px]"
      style={{ color: "var(--ed-text-dim)" }}
    >
      {label}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24"
      />
    </label>
  );
}

interface ToggleProps {
  label: string;
  title?: string;
  checked: boolean;
  onChange(checked: boolean): void;
}

function Toggle({ label, title, checked, onChange }: ToggleProps) {
  return (
    <label
      title={title}
      className="flex cursor-pointer items-center gap-1.5 text-[11.5px]"
      style={{ color: "var(--ed-text-dim)" }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
