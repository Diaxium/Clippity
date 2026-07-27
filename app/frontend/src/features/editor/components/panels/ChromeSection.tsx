import { useMemo } from "react";

import {
  CHROME_PRESETS,
  MAX_CHROME_HEIGHT,
  MIN_CHROME_HEIGHT,
  canCarryChrome,
  chromeInk,
  matchChromePreset,
} from "../../lib/chrome";
import { pageContent } from "../../lib/page";
import { pageFrameId } from "../../lib/crop";
import { useEditorStore } from "../../state/editorStore";
import { NumberField } from "../fields/NumberField";
import { FIELD_LABEL, PanelSection } from "./section";

const SUB = FIELD_LABEL;

/**
 * Window-chrome controls — a macOS or Windows title bar around the capture.
 * The last slice of Fork F4; see ADR 0022 and `lib/chrome.ts` for the model.
 *
 * Document-scoped for {@link BackdropSection}'s reasons and sitting directly
 * beside it: both edit the page treatment rather than a selected mark, and both
 * have to stay reachable in Annotation mode where the Layers rail is hidden
 * (Workstream M2), which an empty selection provides.
 *
 * Hidden entirely when the capture can't carry chrome — "the capture" is
 * whatever holds the largest image fill, and an ellipse has no title bar in
 * either renderer, so offering the control would promise a drawing that never
 * arrives. The same guard the Corners field uses.
 */
export function ChromeSection() {
  const rootIds = useEditorStore((s) => s.rootIds);
  const nodes = useEditorStore((s) => s.nodes);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const applyChrome = useEditorStore((s) => s.applyChrome);
  const setChromeTitle = useEditorStore((s) => s.setChromeTitle);
  const setChromeHeight = useEditorStore((s) => s.setChromeHeight);

  const page = useMemo(() => {
    const pageId = pageFrameId(rootIds, nodes);
    if (!pageId) return null;
    const content = pageContent(nodes);
    if (!content || content.id === pageId) return null;
    const pageNode = nodes[pageId];
    const contentNode = nodes[content.id];
    if (!pageNode || !contentNode || !canCarryChrome(contentNode)) return null;
    return { pageId, contentNode };
  }, [rootIds, nodes]);

  if (!page) return null;
  const scoped =
    selectedIds.length === 0 ||
    (selectedIds.length === 1 && selectedIds[0] === page.pageId);
  if (!scoped) return null;

  const chrome = page.contentNode.chrome ?? null;
  const active = matchChromePreset(chrome);

  return (
    <PanelSection id="chrome" title="Window">
      <p className={SUB}>Frame</p>
      <div className="grid grid-cols-5 gap-1.5">
        {CHROME_PRESETS.map((preset) => {
          const on = active === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              title={preset.label}
              aria-label={preset.label}
              aria-pressed={on}
              onClick={() => applyChrome(preset.id)}
              className={
                "flex h-6 w-full items-center justify-center gap-[3px] rounded-[5px] border transition-shadow " +
                (on
                  ? "border-[color:var(--ed-accent)] ring-1 ring-[color:var(--ed-accent)]"
                  : "border-[color:var(--ed-hairline)] hover:border-[color:var(--ed-text-dim)]")
              }
              style={{
                background:
                  preset.style === null
                    ? "repeating-conic-gradient(var(--ed-elev) 0% 25%, transparent 0% 50%) 50% / 8px 8px"
                    : preset.color,
              }}
            >
              {/* The swatch previews the bar it paints, so the chip can't drift
                  from the result: dots for macOS, a caption glyph for Windows. */}
              {preset.style === "macos" &&
                ["#ff5f57", "#febc2e", "#28c840"].map((c) => (
                  <span
                    key={c}
                    className="h-[5px] w-[5px] rounded-full"
                    style={{ background: c }}
                  />
                ))}
              {preset.style === "windows" && (
                <span
                  className="h-[1px] w-3"
                  style={{ background: chromeInk(preset.color) }}
                />
              )}
            </button>
          );
        })}
      </div>

      {chrome && (
        <>
          <div className="mt-3">
            <p className={SUB}>Title</p>
            <input
              type="text"
              value={chrome.title}
              placeholder="Untitled"
              onChange={(e) => setChromeTitle(e.target.value)}
              aria-label="Window title"
              className="h-7 w-full rounded-[5px] border border-[color:var(--ed-hairline)] bg-[var(--ed-elev)] px-2 text-[12px] text-[var(--ed-text)] outline-none focus:border-[color:var(--ed-accent)]"
            />
          </div>

          <div className="mt-2.5">
            <p className={SUB}>Bar height</p>
            <NumberField
              min={MIN_CHROME_HEIGHT}
              max={MAX_CHROME_HEIGHT}
              value={chrome.height}
              onChange={setChromeHeight}
            />
          </div>
        </>
      )}
    </PanelSection>
  );
}
