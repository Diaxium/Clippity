import { useSelection } from "../../hooks/useSelection";
import { MIXED_LABEL, sharedWhere } from "../../lib/multi";
import { STAMPS, stampLabel, stampOf, stampPreview } from "../../lib/stamps";
import { useEditorStore } from "../../state/editorStore";
import type { SceneNode, StampKind } from "../../types";
import { PanelSection } from "./section";

/** Swatch size for the picker grid, in the icons' own 24-unit authoring space —
 *  so the preview path data *is* the mark's path data, at 1:1. */
const SWATCH = 24;

/**
 * The stamp picker (Fork A-F4) — the whole of a stamp's own UI, because
 * everything else about it is an existing control: the icon's color is the
 * node's Fill, its halo the Stroke, its size the frame.
 *
 * Shown in two situations, which is what makes one grid do both jobs:
 * - a selection containing stamps, where picking **restyles** them; and
 * - the Stamp tool being active, where picking **arms** the next one.
 * Choosing always does both, so the tool keeps drawing whatever you last chose
 * without a separate "default icon" setting to fall out of sync.
 *
 * Multi-select (P3) re-icons every selected stamp together; non-stamps caught in
 * the same marquee sit out. The write goes through `updateEach` so each node's
 * layer name is decided from *its own* previous icon — a shared patch would
 * rename a hand-titled layer along with the untouched ones.
 */
export function StampSection() {
  const updateEach = useEditorStore((s) => s.updateEach);
  const setStampKind = useEditorStore((s) => s.setStampKind);
  const nextKind = useEditorStore((s) => s.stampKind);
  const tool = useEditorStore((s) => s.tool);

  const sel = useSelection();
  const stamps = sel.filter((n) => stampOf(n));
  const ids = stamps.map((n) => n.id);
  const kind = sharedWhere(stamps, (n) => n.stamp?.kind);
  // Neither a stamp to edit nor a stamp about to be drawn.
  if (!kind && tool !== "stamp") return null;

  // With a selection the grid reflects it (nothing highlighted when the marks
  // disagree); with none it reflects what the tool is armed with.
  const active = kind ? (kind.mixed ? null : kind.value) : nextKind;

  const pick = (next: StampKind): void => {
    setStampKind(next);
    if (ids.length === 0) return;
    updateEach(ids, (n) => {
      const spec = stampOf(n);
      if (!spec) return null;
      const patch: Partial<SceneNode> = { stamp: { kind: next } };
      // Rename only a layer still carrying its icon's name — a title the user
      // typed is theirs, and re-icons shouldn't overwrite it.
      if (n.name === stampLabel(spec.kind)) patch.name = stampLabel(next);
      return patch;
    });
  };

  return (
    <PanelSection id="stamp" title="Stamp">
      <div className="grid grid-cols-6 gap-1.5">
        {STAMPS.map(({ kind: id, label }) => {
          const on = active === id;
          const preview = stampPreview(id, SWATCH);
          return (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={on}
              onClick={() => pick(id)}
              className={
                "flex h-7 items-center justify-center rounded-[5px] border transition-shadow " +
                (on
                  ? "border-[color:var(--ed-accent)] text-[var(--ed-text)] ring-1 ring-[color:var(--ed-accent)]"
                  : "border-[color:var(--ed-hairline)] text-[var(--ed-text-dim)] hover:border-[color:var(--ed-text-dim)] hover:text-[var(--ed-text)]")
              }
            >
              <svg
                viewBox={`0 0 ${SWATCH} ${SWATCH}`}
                width={16}
                height={16}
                aria-hidden="true"
                focusable="false"
              >
                {preview.fillD && (
                  <path
                    d={preview.fillD}
                    fillRule="evenodd"
                    fill="currentColor"
                  />
                )}
                {preview.strokeD && (
                  <path
                    d={preview.strokeD}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={preview.weight}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
              </svg>
            </button>
          );
        })}
      </div>

      {kind?.mixed && (
        <p className="mt-2.5 text-[11px] text-[var(--ed-text-dim)]">
          {MIXED_LABEL} — pick one to unify the selection.
        </p>
      )}
      {!kind && (
        <p className="mt-2.5 text-[11px] text-[var(--ed-text-dim)]">
          Drag on the canvas to place a {stampLabel(nextKind).toLowerCase()}.
        </p>
      )}
    </PanelSection>
  );
}
