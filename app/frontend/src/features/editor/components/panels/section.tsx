import type { ReactNode } from "react";

import { useEditorStore } from "../../state/editorStore";

/**
 * Shared shell + header primitives for the right-inspector's property sections.
 *
 * Every section used to inline its own `<section className="px-3 py-2.5">` plus
 * an `<h3>` (static) or a disclosure `<button>` (collapsible) with identical —
 * but copy-pasted — Tailwind. Centralising them here keeps the inspector's
 * spacing, type scale, and the two header styles in lockstep, and means the
 * vertical rhythm is tuned in one place.
 *
 * **Every section now collapses** through one {@link SectionHeader} (there used
 * to be a static `SectionTitle` and a separate `CollapsibleHeader`), and the
 * open/closed bit lives in the store via {@link useSectionOpen} rather than
 * local state — so it survives the section unmounting on a tab switch or a
 * node-type change.
 *
 * A section is a **card** — a raised slab with a gap to its neighbours, not a
 * row in a divided list. That is what lets a collapsed section read as finished
 * rather than truncated: header-only is a complete card, so there's no chevron
 * telling you something is hidden. The trade is that the disclosure control has
 * no glyph, which is why the whole header row is the hit target.
 *
 * Markup contract kept stable for the test suite: the header is the W3C
 * accordion pattern — an `<h3>` *wrapping* a `<button aria-expanded>`. That
 * keeps `getByRole("heading", { name })` resolving (the heading's accessible
 * name comes from the button's text) while also exposing a properly-named
 * disclosure control. The action sits outside the heading, and the count badge
 * is omitted at 0, so both accessible names stay exactly the title.
 */

/** Store-backed collapse state for one section id. Absent id = open. */
export function useSectionOpen(id: string): [boolean, () => void] {
  const open = useEditorStore((s) => s.sectionsOpen[id] ?? true);
  const toggleSection = useEditorStore((s) => s.toggleSection);
  return [open, () => toggleSection(id)];
}

/** Sub-label sitting above a control row ("Alignment", "Size", …). One shared
 *  value so every field label aligns to the same baseline. */
export const FIELD_LABEL = "mb-1.5 text-[11px] text-[var(--ed-text-dim)]";

/** Inline label for a control sharing its row ("Radius", "Blend mode", …),
 *  where the field sits beside the label instead of under it. */
export const ROW_LABEL = "shrink-0 text-[12px] text-[var(--ed-text-dim)]";

/** Card title styling. Sentence case at reading weight, not an uppercase
 *  micro-label: on a card the title is the heading of its own surface, so it
 *  carries the same presence as the panel header above it. */
const SECTION_LABEL =
  "select-none text-[13px] font-semibold text-[var(--ed-text)]";

/**
 * Section wrapper — the card itself: its own raised surface, the collapse
 * header, and the padding every section's body sits in. Owns the disclosure so
 * a call site is just `<PanelSection id="fill" title="Fill">{body}</…>`; the
 * body is unmounted while collapsed, leaving a header-only card.
 */
export function PanelSection({
  id,
  title,
  count,
  action,
  children,
  className,
}: {
  /** Stable key for the remembered open/closed bit. */
  id: string;
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, toggle] = useSectionOpen(id);
  return (
    <section
      className={
        "rounded-[10px] border border-[color:var(--ed-card-hairline)] bg-[var(--ed-card)] px-3.5 py-3" +
        (className ? " " + className : "")
      }
    >
      <SectionHeader
        title={title}
        open={open}
        onToggle={toggle}
        count={count}
        action={action}
      />
      {open && <div className="mt-3">{children}</div>}
    </section>
  );
}

/**
 * Section header — a disclosure button (title + optional count badge) wrapped in
 * an `<h3>`, plus an optional right-aligned action (add fill, visibility
 * toggle, …) that sits outside the heading so it never joins the accessible
 * name. The button stretches across the free space so the whole header row
 * toggles, which is the affordance standing in for the dropped chevron.
 */
export function SectionHeader({
  title,
  open,
  onToggle,
  count = 0,
  action,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-2">
      <h3 className={SECTION_LABEL + " min-w-0 flex-1"}>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex w-full items-center gap-1.5 text-left transition-opacity hover:opacity-80"
        >
          {title}
          {count > 0 && (
            <span className="rounded-full bg-[var(--ed-elev)] px-1.5 text-[10px] font-medium tabular-nums text-[var(--ed-text-dim)]">
              {count}
            </span>
          )}
        </button>
      </h3>
      {action}
    </div>
  );
}
