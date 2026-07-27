import { Eye, EyeOff, Minus, Plus } from "lucide-react";

import { cn } from "@shared/lib/cn";
import { Select } from "@shared/ui";

import { useSelection, selectionIds } from "../../hooks/useSelection";
import {
  entriesAt,
  refsOf,
  sharedEntry,
  toggleTarget,
  triState,
  type EntryPeer,
} from "../../lib/multi";
import { useEditorStore } from "../../state/editorStore";
import {
  canCarrySample,
  SAMPLE_DEFAULT_AMOUNT,
  type EffectType,
  type SampleMode,
  type SampleSpec,
} from "../../types";
import { SELECT_TRIGGER_FULL } from "../fields/chrome";
import { ColorField } from "../fields/ColorField";
import { NumberField } from "../fields/NumberField";
import { SAMPLE_CFG, SAMPLE_MODES } from "./sampleConfig";
import { PanelSection } from "./section";

// Effect types the renderers support (live SVG + Canvas2D export). Inner shadow
// renders in both; shadow `spread` renders for drop shadows only — see ADR 0009.
const EFFECT_TYPE_OPTIONS = [
  { value: "drop-shadow", label: "Drop shadow" },
  { value: "inner-shadow", label: "Inner shadow" },
  { value: "layer-blur", label: "Layer blur" },
] as const;

// Annotation sample modes, surfaced here as first-class effects in Design mode
// — applicable to any area shape, not just the annotation tools (ADR 0015).
const SAMPLE_TYPE_OPTIONS = SAMPLE_MODES.map((m) => ({
  value: m,
  label: SAMPLE_CFG[m].title,
}));

// A sample row leads with its modes, then offers the shadows to convert away. A
// shadow row offers the samples too (when the node can carry one) so any effect
// row converts freely between a shadow and the single per-node sample.
const SAMPLE_THEN_SHADOW = [...SAMPLE_TYPE_OPTIONS, ...EFFECT_TYPE_OPTIONS];
const SHADOW_THEN_SAMPLE = [...EFFECT_TYPE_OPTIONS, ...SAMPLE_TYPE_OPTIONS];

const isSampleMode = (v: string): v is SampleMode =>
  (SAMPLE_MODES as readonly string[]).includes(v);

/**
 * Effects of the primary selection. Shadows expose offset + blur + color;
 * layer blur exposes only its radius.
 *
 * Multi-select is **edit-by-index** (Fork P-F1) — see `StrokeSection`. The two
 * sample⇄shadow *conversions* stay single-node: they rewrite `node.sample`,
 * which is a per-node slot rather than a list row, and a batch conversion would
 * silently discard samples on nodes the primary knows nothing about.
 */
export function EffectsSection() {
  const addEffects = useEditorStore((s) => s.addEffects);
  const updateEffects = useEditorStore((s) => s.updateEffects);
  const removeEffect = useEditorStore((s) => s.removeEffect);
  const removeEffects = useEditorStore((s) => s.removeEffects);
  const updateNode = useEditorStore((s) => s.updateNode);
  const openColorEditor = useEditorStore((s) => s.openColorEditor);
  const setSectionOpen = useEditorStore((s) => s.setSectionOpen);

  const sel = useSelection();
  const node = sel[0];
  if (!node) return null;
  const id = node.id;
  const ids = selectionIds(sel);
  // A blur/pixelate/magnify annotation rides along as the first effect row so it
  // reads as a normal, editable effect in Design mode (ADR 0015).
  const sample = node.sample ?? null;
  const fxCount = node.effects.length + (sample ? 1 : 0);
  // A shadow row can convert into a sample only when this node renders one and
  // doesn't already have one (a node holds at most one sample).
  const shadowRowOptions =
    canCarrySample(node) && !sample ? SHADOW_THEN_SAMPLE : EFFECT_TYPE_OPTIONS;

  // Converting between a shadow (in `effects[]`) and the single `node.sample`
  // is one undo step — wrap the remove+set pair in a history transaction.
  const convertEffectToSample = (effectId: string, mode: SampleMode): void => {
    const store = useEditorStore.getState();
    store.beginHistory();
    removeEffect(id, effectId);
    updateNode(id, {
      sample: { mode, amount: SAMPLE_DEFAULT_AMOUNT[mode], enabled: true },
    });
    store.endHistory();
  };
  const convertSampleToEffect = (type: EffectType): void => {
    const store = useEditorStore.getState();
    store.beginHistory();
    updateNode(id, { sample: null });
    addEffects([id], type);
    store.endHistory();
  };

  return (
    <PanelSection
      id="effects"
      title="Effects"
      count={fxCount}
      action={
        <button
          type="button"
          title="Add effect"
          aria-label="Add effect"
          onClick={() => {
            setSectionOpen("effects", true);
            addEffects(ids);
          }}
          className="flex h-5 w-5 items-center justify-center rounded-[4px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
        >
          <Plus size={14} strokeWidth={2} />
        </button>
      }
    >
      {fxCount === 0 ? (
        <p className="text-[12px] text-[var(--ed-text-faint)]">No effects.</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {sample && (
            <SampleEffectRow
              sample={sample}
              typeOptions={SAMPLE_THEN_SHADOW}
              onTypeChange={(v) =>
                isSampleMode(v)
                  ? updateNode(id, {
                      sample: {
                        ...sample,
                        mode: v,
                        amount: SAMPLE_DEFAULT_AMOUNT[v],
                      },
                    })
                  : convertSampleToEffect(v as EffectType)
              }
              onChange={(patch) =>
                updateNode(id, { sample: { ...sample, ...patch } })
              }
              onRemove={() => updateNode(id, { sample: null })}
            />
          )}
          {node.effects.map((fx, index) => {
            const isBlur = fx.type === "layer-blur";
            const peers = entriesAt(sel, "effects", index);
            const refs = refsOf(peers);
            const visible = triState(
              peers,
              (p: EntryPeer<"effects">) => p.entry.visible
            );
            const color = sharedEntry(peers, (e) => e.color)!;
            const offsetX = sharedEntry(peers, (e) => e.offsetX)!;
            const offsetY = sharedEntry(peers, (e) => e.offsetY)!;
            const blur = sharedEntry(peers, (e) => e.blur)!;
            const spread = sharedEntry(peers, (e) => e.spread)!;
            return (
              <div key={fx.id} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <div className="min-w-0 flex-1">
                    <Select
                      ariaLabel="Effect type"
                      value={fx.type}
                      options={shadowRowOptions}
                      onChange={(v) =>
                        isSampleMode(v)
                          ? convertEffectToSample(fx.id, v)
                          : updateEffects(refs, { type: v as EffectType })
                      }
                      triggerClassName={SELECT_TRIGGER_FULL}
                    />
                  </div>
                  <button
                    type="button"
                    title={visible === "on" ? "Hide effect" : "Show effect"}
                    aria-label={visible === "on" ? "Hide effect" : "Show effect"}
                    onClick={() =>
                      updateEffects(refs, { visible: toggleTarget(visible) })
                    }
                    className={cn(
                      "flex h-7 w-6 shrink-0 items-center justify-center rounded-[6px]",
                      "text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
                    )}
                  >
                    {visible === "on" ? (
                      <Eye size={14} strokeWidth={1.75} />
                    ) : (
                      <EyeOff size={14} strokeWidth={1.75} />
                    )}
                  </button>
                  <button
                    type="button"
                    title="Remove effect"
                    aria-label="Remove effect"
                    onClick={() => removeEffects(refs)}
                    className="flex h-7 w-6 shrink-0 items-center justify-center rounded-[6px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-danger)]"
                  >
                    <Minus size={14} strokeWidth={2} />
                  </button>
                </div>
                {isBlur ? (
                  <NumberField
                    label="Blur"
                    min={0}
                    value={blur.value}
                    mixed={blur.mixed}
                    onChange={(v) => updateEffects(refs, { blur: v })}
                  />
                ) : (
                  <>
                    <ColorField
                      value={color.value}
                      mixed={color.mixed}
                      onChange={(v) => updateEffects(refs, { color: v })}
                      onOpenEditor={(a) =>
                        openColorEditor(
                          { kind: "effect", nodeId: id, effectId: fx.id },
                          a.x,
                          a.y,
                          peers.slice(1).map((p) => ({
                            kind: "effect" as const,
                            nodeId: p.nodeId,
                            effectId: p.entry.id,
                          }))
                        )
                      }
                    />
                    <div className="grid grid-cols-2 gap-1.5">
                      <NumberField
                        label="X"
                        value={offsetX.value}
                        mixed={offsetX.mixed}
                        onChange={(v) => updateEffects(refs, { offsetX: v })}
                      />
                      <NumberField
                        label="Y"
                        value={offsetY.value}
                        mixed={offsetY.mixed}
                        onChange={(v) => updateEffects(refs, { offsetY: v })}
                      />
                      <NumberField
                        label="B"
                        min={0}
                        value={blur.value}
                        mixed={blur.mixed}
                        onChange={(v) => updateEffects(refs, { blur: v })}
                      />
                      {fx.type === "drop-shadow" && (
                        <NumberField
                          label="S"
                          value={spread.value}
                          mixed={spread.mixed}
                          onChange={(v) => updateEffects(refs, { spread: v })}
                        />
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </PanelSection>
  );
}

/**
 * A blur / pixelate / magnify annotation rendered as a standard effect row: a
 * type dropdown (the three sample modes), a visibility toggle, a remove button,
 * and the mode's amount field. Lets Design mode inspect, adjust, and remove these
 * annotations as ordinary effects instead of as a bespoke panel (ADR 0015).
 */
function SampleEffectRow({
  sample,
  typeOptions,
  onTypeChange,
  onChange,
  onRemove,
}: {
  sample: SampleSpec;
  typeOptions: readonly { value: string; label: string }[];
  onTypeChange: (value: string) => void;
  onChange: (patch: Partial<SampleSpec>) => void;
  onRemove: () => void;
}) {
  const cfg = SAMPLE_CFG[sample.mode];
  const visible = sample.enabled !== false;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <Select
            ariaLabel="Effect type"
            value={sample.mode}
            options={typeOptions}
            onChange={onTypeChange}
            triggerClassName={SELECT_TRIGGER_FULL}
          />
        </div>
        <button
          type="button"
          title={visible ? "Hide effect" : "Show effect"}
          aria-label={visible ? "Hide effect" : "Show effect"}
          onClick={() => onChange({ enabled: !visible })}
          className={cn(
            "flex h-7 w-6 shrink-0 items-center justify-center rounded-[6px]",
            "text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
          )}
        >
          {visible ? (
            <Eye size={14} strokeWidth={1.75} />
          ) : (
            <EyeOff size={14} strokeWidth={1.75} />
          )}
        </button>
        <button
          type="button"
          title="Remove effect"
          aria-label="Remove effect"
          onClick={onRemove}
          className="flex h-7 w-6 shrink-0 items-center justify-center rounded-[6px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-danger)]"
        >
          <Minus size={14} strokeWidth={2} />
        </button>
      </div>
      <NumberField
        label={cfg.label}
        suffix={cfg.suffix}
        min={cfg.min}
        step={cfg.step}
        value={sample.amount}
        onChange={(amount) => onChange({ amount })}
      />
    </div>
  );
}
