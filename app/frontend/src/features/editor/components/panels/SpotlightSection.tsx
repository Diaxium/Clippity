import { useSelection } from "../../hooks/useSelection";
import { sharedWhere } from "../../lib/multi";
import {
  SPOTLIGHT_TINTS,
  clampSpotlightOpacity,
  matchSpotlightTint,
} from "../../lib/spotlight";
import { useEditorStore } from "../../state/editorStore";
import { NumberField } from "../fields/NumberField";
import { FIELD_LABEL, PanelSection } from "./section";

const SUB = FIELD_LABEL;

/**
 * Controls for a spotlight region: how strongly to dim the rest of the page
 * (Dim) and which way the dim leans (Tint — dark for a light capture, light for
 * a dark one). Shown in both editor modes whenever the selection contains a
 * spotlight.
 *
 * Multi-select (P3) dims every selected spotlight together; non-spotlights
 * caught in the same marquee sit out. The write goes through `updateEach` so
 * each region keeps the *rest* of its own spec — a shared patch would stamp the
 * primary's color *and* opacity onto all of them (the same reasoning as
 * `CalloutSection`).
 */
export function SpotlightSection() {
  const updateEach = useEditorStore((s) => s.updateEach);

  const sel = useSelection();
  const spots = sel.filter((n) => n.spotlight);
  const ids = spots.map((n) => n.id);
  const opacity = sharedWhere(spots, (n) => n.spotlight?.opacity);
  const color = sharedWhere(spots, (n) => n.spotlight?.color.toLowerCase());
  if (!opacity || !color) return null;

  const setSpot = (patch: { color?: string; opacity?: number }) =>
    updateEach(ids, (n) =>
      n.spotlight ? { spotlight: { ...n.spotlight, ...patch } } : null
    );

  const activeTint = color.mixed ? null : matchSpotlightTint(color.value);

  return (
    <PanelSection id="spotlight" title="Spotlight">
      <p className={SUB}>Dim</p>
      <div className="w-24">
        <NumberField
          suffix="%"
          min={0}
          max={100}
          step={1}
          value={Math.round(opacity.value * 100)}
          mixed={opacity.mixed}
          onChange={(v) => setSpot({ opacity: clampSpotlightOpacity(v / 100) })}
        />
      </div>

      <p className={`${SUB} mt-3`}>Tint</p>
      <div className="flex gap-1.5">
        {SPOTLIGHT_TINTS.map((tint) => {
          const on = activeTint === tint.id;
          return (
            <button
              key={tint.id}
              type="button"
              title={tint.label}
              aria-label={tint.label}
              aria-pressed={on}
              onClick={() => setSpot({ color: tint.color })}
              className={
                "h-6 w-6 rounded-[5px] border transition-shadow " +
                (on
                  ? "border-[color:var(--ed-accent)] ring-1 ring-[color:var(--ed-accent)]"
                  : "border-[color:var(--ed-hairline)] hover:border-[color:var(--ed-text-dim)]")
              }
              style={{ background: tint.color }}
            />
          );
        })}
      </div>
    </PanelSection>
  );
}
