import { useMemo } from "react";

import { Boxes, SquareDashedMousePointer } from "lucide-react";

import { cn } from "@shared/lib/cn";

import { useEditorStore } from "../state/editorStore";
import type { EditorMode, InspectorTab, SceneNode } from "../types";
import { TYPE_ICON } from "./LayersTree";
import { AppearanceSection } from "./panels/AppearanceSection";
import { BackdropSection } from "./panels/BackdropSection";
import { CalloutSection } from "./panels/CalloutSection";
import { ChromeSection } from "./panels/ChromeSection";
import { CornersSection } from "./panels/CornersSection";
import { EffectsSection } from "./panels/EffectsSection";
import { ExportSection } from "./panels/ExportSection";
import { FillSection } from "./panels/FillSection";
import { InspectSection } from "./panels/InspectSection";
import { LayoutSection } from "./panels/LayoutSection";
import { MeasureSection } from "./panels/MeasureSection";
import { PositionSection } from "./panels/PositionSection";
import { SampleSection } from "./panels/SampleSection";
import { ShapeSection } from "./panels/ShapeSection";
import { SpotlightSection } from "./panels/SpotlightSection";
import { StampSection } from "./panels/StampSection";
import { StepSection } from "./panels/StepSection";
import { StrokeSection } from "./panels/StrokeSection";
import { TextSection } from "./panels/TextSection";

/**
 * The inspector's contents, shared by its two host surfaces: the docked rail
 * (`InspectorPanel`) and the floating panel (`FloatingInspector`). Keeping the
 * section list here means the curated per-mode selection (Workstream M2) and
 * the per-tab split are each decided once, not duplicated per host.
 */

/** Friendly type names for the selection summary. */
const TYPE_LABEL: Record<SceneNode["type"], string> = {
  frame: "Frame",
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  image: "Image",
  text: "Text",
  line: "Line",
  arrow: "Arrow",
  polygon: "Polygon",
  star: "Star",
  path: "Path",
};

const TABS: readonly { id: InspectorTab; label: string }[] = [
  { id: "style", label: "Style" },
  { id: "arrange", label: "Arrange" },
  { id: "inspect", label: "Inspect" },
];

/**
 * Panel header: what's selected, and what it measures. The subtitle carries the
 * type and size that used to be buried in the sections below, because those are
 * the two facts you check *before* deciding which tab to open.
 */
export function SelectionSummary() {
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const nodes = useEditorStore((s) => s.nodes);

  const sel = useMemo(
    () =>
      selectedIds
        .map((id) => nodes[id])
        .filter((n): n is SceneNode => Boolean(n)),
    [selectedIds, nodes]
  );

  if (sel.length === 0) return null;
  const multi = sel.length > 1;
  const primary = sel[0]!;
  const Icon = multi ? Boxes : TYPE_ICON[primary.type];
  const label = multi
    ? `${sel.length} layers selected`
    : primary.name || TYPE_LABEL[primary.type];
  const detail = multi
    ? "Multiple layers"
    : `${TYPE_LABEL[primary.type]} • ${Math.round(primary.width)} × ${Math.round(
        primary.height
      )}`;

  return (
    <div className="flex min-w-0 items-center gap-2.5 px-3.5 py-3">
      <Icon
        size={18}
        strokeWidth={1.5}
        className="shrink-0 text-[var(--ed-text-dim)]"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold leading-tight text-[var(--ed-text)]">
          {label}
        </p>
        <p className="truncate text-[11px] leading-tight text-[var(--ed-text-dim)]">
          {detail}
        </p>
      </div>
    </div>
  );
}

/** The tab strip under the header. Accent underline on the active tab — one of
 *  the three places the editor spends its accent (see theme.css). */
export function InspectorTabs() {
  const tab = useEditorStore((s) => s.inspectorTab);
  const setTab = useEditorStore((s) => s.setInspectorTab);
  return (
    <div
      role="tablist"
      aria-label="Inspector"
      className="flex shrink-0 border-b border-[color:var(--ed-hairline)] px-1"
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => setTab(t.id)}
          className={cn(
            "relative flex-1 py-2 text-[12px] font-medium transition-colors",
            tab === t.id
              ? "text-[var(--ed-text)]"
              : "text-[var(--ed-text-dim)] hover:text-[var(--ed-text)]"
          )}
        >
          {t.label}
          {tab === t.id && (
            <span
              aria-hidden
              className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[var(--ed-accent)]"
            />
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Property sections for the selection, curated by mode and split by tab.
 *
 * Sections still self-gate on the selection (a Callout panel has nothing to say
 * about a rectangle), so which of the listed sections actually appear is
 * decided one level down. This only decides which are *eligible*.
 */
export function InspectorSections({ mode }: { mode: EditorMode }) {
  const tab = useEditorStore((s) => s.inspectorTab);
  const isAnnotate = mode === "annotate";

  return (
    <div className="flex flex-col gap-2.5 p-2.5">
      {tab === "style" && (
        <>
          {/* Document-scoped, so these lead; each self-gates to an empty
              selection or the page frame (see BackdropSection). */}
          <BackdropSection />
          <ChromeSection />
          {!isAnnotate && <ShapeSection />}
          {/* Annotate mode gets the dedicated Sample panel; Design mode shows
              the same sample inside Effects instead (ADR 0015). */}
          {isAnnotate && <SampleSection />}
          <StepSection />
          <CalloutSection />
          <SpotlightSection />
          <MeasureSection />
          <StampSection />
          <AppearanceSection />
          <CornersSection />
          <TextSection />
          <FillSection />
          <StrokeSection />
          {!isAnnotate && <EffectsSection />}
          <ExportSection />
        </>
      )}
      {tab === "arrange" && (
        <>
          <PositionSection />
          <LayoutSection />
        </>
      )}
      {tab === "inspect" && <InspectSection />}
    </div>
  );
}

/**
 * Shown in place of the sections when nothing is selected — but not *only* the
 * hint: an empty selection is how you address the page itself, so the Backdrop
 * and Window controls live here too (see `BackdropSection`). They render
 * nothing on a document with no page frame, leaving the bare hint.
 */
export function InspectorEmpty({ mode }: { mode: EditorMode }) {
  return (
    <div className="flex flex-col gap-2.5 p-2.5">
      <BackdropSection />
      <ChromeSection />
      {/* Self-gates to the Stamp tool being armed, which is the one thing worth
          choosing *before* there's a mark to select. */}
      <StampSection />
      <InspectorHint mode={mode} />
    </div>
  );
}

function InspectorHint({ mode }: { mode: EditorMode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 px-6 py-10 text-center">
      <div
        className="flex h-10 w-10 items-center justify-center rounded-full"
        style={{ background: "var(--ed-elev)", color: "var(--ed-text-dim)" }}
      >
        <SquareDashedMousePointer size={18} strokeWidth={1.5} />
      </div>
      <p className="text-[12px] leading-snug text-[var(--ed-text-dim)]">
        {mode === "annotate"
          ? "Select a mark to edit it."
          : "Select a layer to edit its design."}
      </p>
    </div>
  );
}
