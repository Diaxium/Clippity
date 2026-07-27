import { useState } from "react";

import { Select } from "@shared/ui";

import { useEditorExport } from "../../hooks/useEditorExport";
import type { ExportFormat } from "../../lib/render";
import { useEditorStore } from "../../state/editorStore";
import { SELECT_TRIGGER_FULL } from "../fields/chrome";
import { NumberField } from "../fields/NumberField";
import { PanelSection } from "./section";

const SCALE_OPTIONS = [
  { value: "1", label: "1x" },
  { value: "2", label: "2x" },
  { value: "3", label: "3x" },
] as const;

const FORMAT_OPTIONS = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPG" },
  { value: "webp", label: "WebP" },
] as const;

/** Formats whose encoder takes a quality factor — PNG is lossless. */
const LOSSY: readonly ExportFormat[] = ["jpeg", "webp"];

/** Percent, matching the browser's 0.92 `toDataURL` default. */
const DEFAULT_QUALITY_PCT = 92;

/** Export the current page (or the selected node) as a PNG/JPG/WebP capture. */
export function ExportSection() {
  const docName = useEditorStore((s) => s.docName);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const { busy, exportImage } = useEditorExport();
  const [scale, setScale] = useState("1");
  const [format, setFormat] = useState<ExportFormat>("png");
  const [quality, setQuality] = useState(DEFAULT_QUALITY_PCT);

  const selectedId = selectedIds[0] ?? null;
  const lossy = LOSSY.includes(format);

  return (
    <PanelSection id="export" title="Export">
      <div className="mb-2 flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <Select
            ariaLabel="Export format"
            value={format}
            options={FORMAT_OPTIONS}
            onChange={(v) => setFormat(v as ExportFormat)}
            triggerClassName={SELECT_TRIGGER_FULL}
          />
        </div>
        <div className="w-16 shrink-0">
          <Select
            ariaLabel="Export scale"
            value={scale}
            options={SCALE_OPTIONS}
            onChange={setScale}
            triggerClassName={SELECT_TRIGGER_FULL}
          />
        </div>
      </div>
      {/* Quality only exists for the lossy encoders; PNG ignores it. */}
      {lossy && (
        <div className="mb-2">
          <NumberField
            label="Quality"
            value={quality}
            onChange={setQuality}
            min={1}
            max={100}
            suffix="%"
          />
        </div>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void exportImage({
            scale: Number(scale),
            nodeId: selectedId,
            format,
            quality: lossy ? quality / 100 : undefined,
          })
        }
        className="h-8 w-full rounded-[8px] bg-[var(--ed-accent)] text-[13px] font-medium text-[var(--ed-on-accent)] hover:bg-[var(--ed-accent-hover)] disabled:opacity-50"
      >
        {busy ? "Exporting…" : `Export ${selectedId ? "selection" : docName}`}
      </button>
    </PanelSection>
  );
}
