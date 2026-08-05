/**
 * Feature flags — the switches this build exposes, and the user's
 * overrides for them.
 *
 * The table is short on purpose. A flag with no consumer is a lie the
 * settings page tells on the app's behalf, so the registry
 * (`shared/lib/featureFlags`) only lists switches something actually
 * reads — today, two capture paths that each already have a tested
 * fallback, which is what makes turning them off safe rather than
 * merely possible.
 */

import { cn } from "@shared/lib/cn";
import { Button } from "@shared/ui";
import {
  FEATURE_FLAGS,
  formatFlags,
  pruneOverrides,
  resolveFlags,
  withOverride,
  type FlagOverrides,
} from "@shared/lib/featureFlags";
import { SectionCard } from "@features/settings/components/SectionCard";

import { ActionRow, CopyButton } from "./DevRow";

interface FeatureFlagsCardProps {
  overrides: FlagOverrides;
  onChange(next: FlagOverrides): void;
}

/** The three states a flag can be put into, in the order they read. */
const STATES = [
  { value: "default", label: "Default" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

export function FeatureFlagsCard({
  overrides,
  onChange,
}: FeatureFlagsCardProps) {
  const resolved = resolveFlags(overrides);
  const overrideCount = resolved.filter((f) => f.source === "override").length;

  return (
    <SectionCard title="Feature flags">
      <ActionRow
        label="Overrides"
        description={
          overrideCount === 0
            ? "Every flag is following this build's default."
            : `${overrideCount} flag${overrideCount === 1 ? "" : "s"} overridden.`
        }
      >
        <CopyButton text={() => formatFlags(overrides)} label="Copy flags" />
        <Button
          variant="secondary"
          size="sm"
          disabled={overrideCount === 0}
          onClick={() => onChange({})}
        >
          Reset all
        </Button>
      </ActionRow>

      {resolved.map(({ def, enabled, source }) => (
        <div key={def.id} className="px-5 py-3.5">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-[var(--color-ink)]">
                {def.label}
              </p>
              <p className="mt-0.5 text-[12px] text-[var(--color-slate)]">
                {def.description}
              </p>
              <p className="mt-1 font-mono text-[11px] text-[var(--color-hint)]">
                {def.id} · {def.consumer} ·{" "}
                {def.restartRequired
                  ? "restart required"
                  : "applies immediately"}{" "}
                · currently {enabled ? "on" : "off"} ({source})
              </p>
            </div>
            <div className="inline-flex shrink-0 items-center gap-1 rounded-[10px] bg-[color:var(--color-overlay-1)] p-1">
              {STATES.map((state) => {
                const active =
                  state.value === "default"
                    ? source === "default"
                    : source === "override" &&
                      enabled === (state.value === "on");
                return (
                  <button
                    key={state.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      onChange(
                        pruneOverrides(
                          withOverride(
                            overrides,
                            def.id,
                            state.value === "default"
                              ? "default"
                              : state.value === "on"
                          )
                        )
                      )
                    }
                    className={cn(
                      "focus-ring inline-flex items-center rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                      active
                        ? "bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-subtle)]"
                        : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
                    )}
                  >
                    {state.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ))}

      {FEATURE_FLAGS.length === 0 && (
        <p className="px-5 py-3 text-[12.5px] text-[var(--color-slate)]">
          This build exposes no feature flags.
        </p>
      )}
    </SectionCard>
  );
}
