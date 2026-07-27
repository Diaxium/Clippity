import { useMemo } from "react";

import {
  BACKDROP_PRESETS,
  MAX_PAGE_PADDING,
  hasContentShadow,
  matchBackdropPreset,
  pageContent,
  pagePadding,
} from "../../lib/page";
import { pageFrameId } from "../../lib/crop";
import { hasCornerRadius } from "../../types";
import { useEditorStore } from "../../state/editorStore";
import { NumberField } from "../fields/NumberField";
import { FIELD_LABEL, PanelSection } from "./section";

const SUB = FIELD_LABEL;

/**
 * The "beautiful screenshot" controls — page padding, a backdrop behind the
 * capture, and the capture's own corner rounding + lift shadow. The second half
 * of Fork F4; see ADR 0020 and `lib/page.ts` for the model.
 *
 * **Why this section is document-scoped, not selection-scoped.** Every other
 * inspector section edits the selection. These four fields edit the *page* —
 * and the page is exactly what you have "selected" when you have nothing
 * selected, the same way Figma surfaces the canvas background on an empty
 * selection. So it renders on an empty selection or when the page frame itself
 * is selected, and nowhere else: with a mark selected it would be an unrelated
 * control sitting under that mark's properties.
 *
 * That placement also solves an Annotation-mode problem — the Layers rail is
 * hidden there (Workstream M2), so selecting the page frame to reach its fills
 * isn't practical. Pressing Escape is.
 */
export function BackdropSection() {
  const rootIds = useEditorStore((s) => s.rootIds);
  const nodes = useEditorStore((s) => s.nodes);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const setPagePadding = useEditorStore((s) => s.setPagePadding);
  const applyBackdrop = useEditorStore((s) => s.applyBackdrop);
  const setContentRadius = useEditorStore((s) => s.setContentRadius);
  const setContentShadow = useEditorStore((s) => s.setContentShadow);

  const page = useMemo(() => {
    const pageId = pageFrameId(rootIds, nodes);
    if (!pageId) return null;
    const content = pageContent(nodes);
    if (!content || content.id === pageId) return null;
    const pageNode = nodes[pageId];
    const contentNode = nodes[content.id];
    if (!pageNode || !contentNode) return null;
    return { pageNode, contentNode, contentRect: content.rect };
  }, [rootIds, nodes]);

  if (!page) return null;
  // Document-scoped: empty selection, or the page frame itself (see the note
  // above). Any other selection means the user is editing a mark, not the page.
  const scoped =
    selectedIds.length === 0 ||
    (selectedIds.length === 1 && selectedIds[0] === page.pageNode.id);
  if (!scoped) return null;

  const { pageNode, contentNode } = page;
  const padding = pagePadding(pageNode, page.contentRect);
  const activePreset = matchBackdropPreset(pageNode.fills);
  const shadow = hasContentShadow(contentNode);
  // A capture is normally an image node, but "the capture" is whatever carries
  // the largest image fill — an ellipse could. Only offer Corners when the node
  // actually has a radius for both renderers to draw.
  const roundable = hasCornerRadius(contentNode);

  return (
    <PanelSection id="backdrop" title="Backdrop">
      <p className={SUB}>Style</p>
      <div className="grid grid-cols-7 gap-1.5">
        {BACKDROP_PRESETS.map((preset) => {
          const active = activePreset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              title={preset.label}
              aria-label={preset.label}
              aria-pressed={active}
              onClick={() => applyBackdrop(preset.id)}
              className={
                "h-6 w-full rounded-[5px] border transition-shadow " +
                (active
                  ? "border-[color:var(--ed-accent)] ring-1 ring-[color:var(--ed-accent)]"
                  : "border-[color:var(--ed-hairline)] hover:border-[color:var(--ed-text-dim)]")
              }
              style={{
                background:
                  preset.id === "none"
                    ? // Checkerboard reads as "transparent" the way every
                      // design tool spells it — a flat swatch would just look
                      // like another dark color against the panel.
                      "repeating-conic-gradient(var(--ed-elev) 0% 25%, transparent 0% 50%) 50% / 8px 8px"
                    : preset.swatch,
              }}
            />
          );
        })}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <div>
          <p className={SUB}>Padding</p>
          <NumberField
            min={0}
            max={MAX_PAGE_PADDING}
            value={padding}
            onChange={setPagePadding}
          />
        </div>
        {roundable && (
          <div>
            <p className={SUB}>Corners</p>
            <NumberField
              min={0}
              value={contentNode.cornerRadius}
              onChange={setContentRadius}
            />
          </div>
        )}
      </div>

      <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[12px] text-[var(--ed-text)]">
        <input
          type="checkbox"
          checked={shadow}
          onChange={(e) => setContentShadow(e.target.checked)}
          className="h-3.5 w-3.5 accent-[var(--ed-accent)]"
        />
        Shadow
      </label>
    </PanelSection>
  );
}
