import { useState, type ReactNode } from "react";

import { Check, Copy } from "lucide-react";

import { rotatedAABB } from "../../geometry";
import { useSelection } from "../../hooks/useSelection";
import { paintPreviewCss } from "../../lib/paint";
import type { SceneNode } from "../../types";
import { PanelSection } from "./section";

/** Trim a measurement to whole pixels for display — the inspector reports what
 *  the export will contain, and the exporters rasterize on the pixel grid. */
const px = (n: number): string => `${Math.round(n)}`;

/**
 * Read-only readout of the primary selection: its measured geometry, how it
 * composites, and the paints it carries.
 *
 * This is the one place the *rotated* bounding box is reported rather than the
 * unrotated frame the Arrange tab edits. Those disagree for any rotated node,
 * and the difference matters precisely when you're measuring rather than
 * editing — a rotated 200×100 label occupies a wider box on the page, and that
 * box is what an export crop has to clear.
 */
export function InspectSection() {
  const sel = useSelection();
  const node = sel[0];
  if (!node) return null;

  const multi = sel.length > 1;
  const box = rotatedAABB(node);

  return (
    <>
      <PanelSection id="inspect-geometry" title="Measurements">
        {multi && (
          <p className="mb-2.5 text-[11px] leading-snug text-[var(--ed-text-dim)]">
            Showing {node.name} — the primary of {sel.length} selected layers.
          </p>
        )}
        <dl className="flex flex-col gap-1.5">
          <Row label="Size" value={`${px(node.width)} × ${px(node.height)}`} />
          <Row label="Position" value={`${px(node.x)}, ${px(node.y)}`} />
          <Row label="Rotation" value={`${Math.round(node.rotation)}°`} />
          {/* Only worth the row when rotation actually makes it differ. */}
          {Math.round(node.rotation) % 360 !== 0 && (
            <Row
              label="Bounding box"
              value={`${px(box.width)} × ${px(box.height)}`}
            />
          )}
        </dl>
      </PanelSection>

      <PanelSection id="inspect-compositing" title="Compositing">
        <dl className="flex flex-col gap-1.5">
          <Row label="Opacity" value={`${Math.round(node.opacity * 100)}%`} />
          <Row label="Blend" value={node.blendMode ?? "normal"} />
          <Row label="Visible" value={node.visible ? "Yes" : "No"} />
          {node.locked && <Row label="Locked" value="Yes" />}
        </dl>
      </PanelSection>

      <PanelSection id="inspect-paints" title="Paints">
        <PaintList node={node} />
      </PanelSection>
    </>
  );
}

/** The node's fills and strokes as swatch + value rows, with the value
 *  copyable — the reason to open this tab is usually to take a hex elsewhere. */
function PaintList({ node }: { node: SceneNode }) {
  const rows: { key: string; swatch: string; label: string; value: string }[] =
    [];

  node.fills.forEach((fill, i) => {
    rows.push({
      key: `fill-${fill.id}`,
      swatch: paintPreviewCss(fill),
      label: node.fills.length > 1 ? `Fill ${i + 1}` : "Fill",
      value:
        fill.type === "solid"
          ? fill.color.toUpperCase()
          : fill.type === "image"
            ? "Image"
            : "Gradient",
    });
  });
  node.strokes.forEach((stroke, i) => {
    rows.push({
      key: `stroke-${stroke.id}`,
      swatch: stroke.color,
      label: node.strokes.length > 1 ? `Stroke ${i + 1}` : "Stroke",
      value: `${stroke.color.toUpperCase()} · ${stroke.width}px`,
    });
  });

  if (rows.length === 0)
    return (
      <p className="text-[12px] text-[var(--ed-text-dim)]">
        No fills or strokes.
      </p>
    );

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-5 w-5 shrink-0 rounded-[5px] border border-[color:var(--ed-control-hairline)]"
            style={{ background: row.swatch }}
          />
          <span className="shrink-0 text-[12px] text-[var(--ed-text-dim)]">
            {row.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-right text-[12px] tabular-nums text-[var(--ed-text)]">
            {row.value}
          </span>
          <CopyButton
            label={`Copy ${row.label.toLowerCase()}`}
            text={row.value}
          />
        </div>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-[12px] text-[var(--ed-text-dim)]">{label}</dt>
      <dd className="text-[12px] font-medium tabular-nums text-[var(--ed-text)]">
        {value}
      </dd>
    </div>
  );
}

/** Copy-to-clipboard with a brief acknowledgement. Silently no-ops where the
 *  async clipboard is unavailable (it is behind a permission prompt in some
 *  webviews) rather than surfacing a failure for a convenience action. */
function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {}
        );
      }}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-[var(--ed-text-faint)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
    >
      {copied ? (
        <Check
          size={13}
          strokeWidth={2.5}
          className="text-[var(--ed-accent)]"
        />
      ) : (
        <Copy size={13} strokeWidth={1.75} />
      )}
    </button>
  );
}
