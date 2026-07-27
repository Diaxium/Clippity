import { Link, Radius, Unlink } from "lucide-react";

import { cn } from "@shared/lib/cn";

import { useSelection, selectionIds } from "../../hooks/useSelection";
import { sharedWhere, toggleTarget, triState } from "../../lib/multi";
import { useEditorStore } from "../../state/editorStore";
import { hasCornerRadius, type Corners, type SceneNode } from "../../types";
import { NumberField } from "../fields/NumberField";
import { PanelSection, ROW_LABEL } from "./section";

/** The four corners of a radius-capable node, expanded from the uniform value
 *  when it carries no independent set. */
function cornersOf(node: SceneNode): Corners | undefined {
  if (!hasCornerRadius(node)) return undefined;
  return (
    node.cornerRadii ?? {
      tl: node.cornerRadius,
      tr: node.cornerRadius,
      br: node.cornerRadius,
      bl: node.cornerRadius,
    }
  );
}

/**
 * Corner radius — one uniform value, or four independent corners behind the
 * link toggle. Split out of `AppearanceSection` so the card list matches the
 * shape of the properties: compositing and geometry are different questions,
 * and only some node types can answer this one.
 *
 * Multi-select (P3): the controls appear whenever *any* selected node can carry
 * a radius and write only to those, so a mixed selection of rectangles and
 * arrows still rounds the rectangles instead of hiding the section.
 */
export function CornersSection() {
  const updateEach = useEditorStore((s) => s.updateEach);

  const sel = useSelection();
  if (sel.length === 0) return null;
  const ids = selectionIds(sel);

  const radiusNodes = sel.filter(hasCornerRadius);
  if (radiusNodes.length === 0) return null;

  const radius = sharedWhere(sel, (n) =>
    hasCornerRadius(n) ? n.cornerRadius : undefined
  );
  if (!radius) return null;

  // "Independent corners" is on only when every radius-capable node has a
  // `cornerRadii` set — a split reads as off, so one press unifies them.
  const independent = triState(radiusNodes, (n) => n.cornerRadii != null);
  const corners = sharedWhere(
    sel,
    cornersOf,
    (c) => `${c.tl}/${c.tr}/${c.br}/${c.bl}`
  );

  /** Write one corner (or all four) on every radius-capable node, preserving
   *  each node's other corners rather than stamping the primary's over them. */
  const setCorner = (key: keyof Corners | "all", v: number) =>
    updateEach(ids, (n) => {
      if (!hasCornerRadius(n)) return null;
      const c = cornersOf(n)!;
      if (key === "all") {
        return n.cornerRadii != null
          ? { cornerRadius: v, cornerRadii: { tl: v, tr: v, br: v, bl: v } }
          : { cornerRadius: v };
      }
      return { cornerRadii: { ...c, [key]: v } };
    });

  return (
    <PanelSection id="corners" title="Corners">
      <div className="flex items-center gap-2">
        <span className={ROW_LABEL}>Radius</span>
        <div className="min-w-0 flex-1">
          <NumberField
            icon={<Radius size={13} strokeWidth={1.75} />}
            min={0}
            value={radius.value}
            mixed={radius.mixed}
            onChange={(v) => setCorner("all", v)}
          />
        </div>
        <button
          type="button"
          title="Independent corners"
          aria-label="Independent corners"
          aria-pressed={independent === "on"}
          onClick={() => {
            const on = toggleTarget(independent);
            updateEach(ids, (n) =>
              hasCornerRadius(n)
                ? { cornerRadii: on ? { ...cornersOf(n)! } : null }
                : null
            );
          }}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px]",
            independent === "on"
              ? "bg-[var(--ed-active-bg)] text-[var(--ed-active-text)]"
              : "text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
          )}
        >
          {independent === "on" ? (
            <Unlink size={14} strokeWidth={1.75} />
          ) : (
            <Link size={14} strokeWidth={1.75} />
          )}
        </button>
      </div>

      {independent === "on" && corners && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(["tl", "tr", "bl", "br"] as const).map((key) => {
            const c = sharedWhere(sel, (n) => cornersOf(n)?.[key]);
            return (
              <NumberField
                key={key}
                icon={<Radius size={13} strokeWidth={1.75} />}
                min={0}
                value={c?.value ?? 0}
                mixed={c?.mixed ?? false}
                onChange={(v) => setCorner(key, v)}
              />
            );
          })}
        </div>
      )}
    </PanelSection>
  );
}
