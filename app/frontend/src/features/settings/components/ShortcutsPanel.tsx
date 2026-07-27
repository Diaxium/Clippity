/**
 * Settings → Shortcuts. Customize every in-app keyboard shortcut (editor /
 * library / quick-capture) and the OS-global capture hotkey.
 *
 * The list is generated from the keybind registries via
 * `shortcuts/catalog`, so it can't drift from the real bindings. Recording
 * a combo writes an entry into `shortcuts.overrides` (keyed by the binding's
 * fully-qualified id); Reset removes it. Conflicts — two bindings sharing a
 * key in the same scope + context — are detected live and flagged inline
 * plus summarized at the top. All writes go through `onChange`, which the
 * panel host persists optimistically.
 */

import { AlertTriangle, RotateCcw } from "lucide-react";
import { useMemo } from "react";

import { parseCombo } from "@features/editor/keybinds/keybindUtils";
import {
  QUICK_CAPTURE_ACTIONS,
  unavailabilityOf,
} from "@features/home/lib/quickCapture";
import { ToggleSwitch } from "@shared/ui";
import { useCapabilities } from "@state/useCapabilities";

import type { ShortcutsSettings } from "../types";
import { Row } from "./Row";
import { SectionCard } from "./SectionCard";
import {
  entryKeys,
  findShortcutConflicts,
  isEntryOverridden,
  SHORTCUT_ENTRIES,
  SHORTCUT_GROUPS,
} from "../shortcuts/catalog";
import { KeyRecorderField } from "../shortcuts/KeyRecorderField";

/** Registry default for the global capture hotkey — mirrors the Rust
 *  `default_global_capture`. Reset restores it. */
const DEFAULT_GLOBAL_CAPTURE = "Mod+Shift+2";

interface ShortcutsPanelProps {
  value: ShortcutsSettings;
  onChange(next: ShortcutsSettings): void;
}

/** A global accelerator without a Ctrl/Cmd/Alt modifier would grab a bare
 *  key system-wide — almost never what the user wants. */
function lacksGlobalModifier(combo: string): boolean {
  if (!combo) return false;
  const sig = parseCombo(combo);
  return !sig.mod && !sig.alt;
}

export function ShortcutsPanel({ value, onChange }: ShortcutsPanelProps) {
  const overrides = value.overrides;
  const capabilities = useCapabilities();

  /**
   * Hide a row for an action this installation can't perform — a key the
   * user rebinds but that can never fire is worse than no row at all.
   *
   * Only the quick-capture group can be affected (the editor and library
   * bindings are all `core`), and the same predicate the launcher cards use
   * decides it, so the two can't disagree. Conflict detection and Reset-all
   * still scan the full catalog: an override left behind for a hidden
   * binding is inert, and dropping it would silently discard the user's
   * customization if they later reinstalled the component.
   */
  const isBindable = (entry: { scope: string; id: string }) => {
    if (entry.scope !== "quickCapture") return true;
    const action = QUICK_CAPTURE_ACTIONS.find((a) => a.id === entry.id);
    return !action || unavailabilityOf(action, capabilities) === null;
  };

  const conflicts = useMemo(
    () => findShortcutConflicts(overrides),
    [overrides],
  );
  const overriddenCount = useMemo(
    () => SHORTCUT_ENTRIES.filter((e) => isEntryOverridden(e, overrides)).length,
    [overrides],
  );

  const setOverride = (fqid: string, combos: string[]) =>
    onChange({ ...value, overrides: { ...overrides, [fqid]: combos } });

  const clearOverride = (fqid: string) => {
    const next = { ...overrides };
    delete next[fqid];
    onChange({ ...value, overrides: next });
  };

  const resetAll = () => onChange({ ...value, overrides: {} });

  const globalOverridden =
    value.globalCapture !== DEFAULT_GLOBAL_CAPTURE || !value.globalCaptureEnabled;
  const globalNeedsModifier = lacksGlobalModifier(value.globalCapture);

  return (
    <>
      {conflicts.size > 0 && (
        <div className="mb-5 flex items-start gap-2.5 rounded-[12px] border border-[color:var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3">
          <AlertTriangle
            size={16}
            strokeWidth={1.9}
            className="mt-0.5 shrink-0 text-[var(--color-danger)]"
          />
          <p className="text-[12.5px] text-[var(--color-ink)]">
            Some shortcuts share the same keys within one area. Only the
            higher-priority binding will fire — the clashing ones are marked
            below.
          </p>
        </div>
      )}

      <SectionCard title="Global capture hotkey">
        {capabilities.globalHotkeys ? (
          <>
            <Row
              label="Enable global capture hotkey"
              description="Start a region capture from anywhere, even when Clippity isn't focused."
              control={
                <ToggleSwitch
                  checked={value.globalCaptureEnabled}
                  onChange={(globalCaptureEnabled) =>
                    onChange({ ...value, globalCaptureEnabled })
                  }
                  label="Enable global capture hotkey"
                />
              }
            />
            <Row
              label="Capture shortcut"
              description={
                globalNeedsModifier
                  ? "Add a Ctrl/Alt modifier — a bare key would be captured system-wide."
                  : "System-wide shortcut that opens the region overlay."
              }
              control={
                <KeyRecorderField
                  actionLabel="global capture"
                  combos={value.globalCapture ? [value.globalCapture] : []}
                  overridden={globalOverridden}
                  conflict={globalNeedsModifier}
                  // Recording implies the user wants it live — enable on capture.
                  onRecord={(combo) =>
                    onChange({
                      ...value,
                      globalCapture: combo,
                      globalCaptureEnabled: true,
                    })
                  }
                  onReset={() =>
                    onChange({
                      ...value,
                      globalCapture: DEFAULT_GLOBAL_CAPTURE,
                      globalCaptureEnabled: true,
                    })
                  }
                  onClear={() => onChange({ ...value, globalCapture: "" })}
                />
              }
            />
          </>
        ) : (
          // The capture integration *is* the OS-global accelerator, and the
          // backend registers nothing without it. Showing the recorder would
          // let the user set a hotkey that could never fire, so the section
          // states the reason and the remedy instead.
          <p className="px-1 py-1.5 text-[12.5px] leading-relaxed text-[var(--color-slate)]">
            The capture integration wasn&rsquo;t selected when Clippity was
            installed, so there is no system-wide capture hotkey. Re-run the
            installer and choose Modify to add it. The in-app shortcuts below
            work either way.
          </p>
        )}
      </SectionCard>

      <div className="mb-4 flex items-center justify-between">
        <p className="text-[12px] text-[var(--color-slate)]">
          {overriddenCount === 0
            ? "All shortcuts are at their defaults."
            : `${overriddenCount} shortcut${overriddenCount === 1 ? "" : "s"} customized.`}
        </p>
        <button
          type="button"
          onClick={resetAll}
          disabled={overriddenCount === 0}
          className="focus-ring flex items-center gap-1.5 rounded-[8px] border border-[color:var(--hairline)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--color-slate)] transition-colors enabled:hover:bg-[var(--color-overlay-1)] enabled:hover:text-[var(--color-ink)] disabled:cursor-default disabled:opacity-40"
        >
          <RotateCcw size={13} strokeWidth={1.9} />
          Reset all
        </button>
      </div>

      {SHORTCUT_GROUPS.map((group) => (
        <SectionCard key={group.key} title={group.label}>
          {group.entries.filter(isBindable).map((entry) => (
            <Row
              key={entry.fqid}
              label={entry.label}
              control={
                <KeyRecorderField
                  actionLabel={entry.label}
                  combos={entryKeys(entry, overrides)}
                  overridden={isEntryOverridden(entry, overrides)}
                  conflict={conflicts.has(entry.fqid)}
                  onRecord={(combo) => setOverride(entry.fqid, [combo])}
                  onReset={() => clearOverride(entry.fqid)}
                  onClear={() => setOverride(entry.fqid, [])}
                />
              }
            />
          ))}
        </SectionCard>
      ))}
    </>
  );
}
