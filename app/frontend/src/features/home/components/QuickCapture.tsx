/**
 * "Quick capture" launcher row — four cards that jump straight into a
 * capture flow. Screenshot is the featured card (accent border + soft
 * wash). Available cards show their live keyboard shortcut and fire the
 * capture on click or hotkey.
 *
 * A card can be disabled for two different reasons, and says which: the
 * port hasn't landed ("Soon"), or the component was declined when Clippity
 * was installed ("Not installed" — see `domain::provisioning`). The second
 * is the user's own past choice and is reversible through the installer, so
 * the card explains it instead of disappearing.
 */

import { formatCombo } from "@features/editor/keybinds/keybindUtils";
import { effectiveKeys, getKeybindOverrides } from "@shared/keybinds/overrides";
import { useKeybindOverridesVersion } from "@shared/keybinds/useKeybindOverrides";
import { cn } from "@shared/lib/cn";
import { useCapabilities } from "@state/useCapabilities";

import {
  QUICK_CAPTURE_ACTIONS,
  unavailabilityOf,
  type QuickCaptureAction,
  type QuickCaptureId,
  type Unavailability,
} from "../lib/quickCapture";
import { IconTile } from "./primitives";

interface QuickCaptureProps {
  onLaunch: (id: QuickCaptureId) => void;
}

export function QuickCapture({ onLaunch }: QuickCaptureProps) {
  // Re-render when the user remaps a quick-capture key so the card chips
  // track the live binding.
  useKeybindOverridesVersion();
  // Cards for components that were declined at install time render disabled
  // with a "Not installed" pill rather than vanishing: a user who doesn't
  // remember unchecking the GIF encoder deserves an answer for where the
  // card went, and one they can act on.
  const capabilities = useCapabilities();
  return (
    <div>
      <h2 className="mb-3 text-[13px] font-semibold text-[var(--color-slate)]">
        Quick capture
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {QUICK_CAPTURE_ACTIONS.map((action) => (
          <QuickCaptureCard
            key={action.id}
            action={action}
            unavailable={unavailabilityOf(action, capabilities)}
            onLaunch={() => onLaunch(action.id)}
          />
        ))}
      </div>
    </div>
  );
}

/** Pill text + hover explanation per reason a card is disabled. */
const UNAVAILABLE_COPY: Record<
  Unavailability,
  { pill: string; title: string }
> = {
  soon: { pill: "Soon", title: "Coming in a later release." },
  "not-installed": {
    pill: "Not installed",
    title:
      "This component wasn't selected when Clippity was installed. Re-run the installer and choose Modify to add it.",
  },
};

function QuickCaptureCard({
  action,
  unavailable,
  onLaunch,
}: {
  action: QuickCaptureAction;
  unavailable: Unavailability | null;
  onLaunch: () => void;
}) {
  const disabled = unavailable !== null;
  // Effective combo: the user's override if set, else the default. Only
  // the first combo is chipped (cards have room for one shortcut).
  const combos = disabled
    ? []
    : effectiveKeys(
        "quickCapture",
        action.id,
        action.combo ? [action.combo] : [],
        getKeybindOverrides()
      );
  const primaryCombo = combos[0];
  const keys = primaryCombo ? formatCombo(primaryCombo) : [];

  return (
    <button
      type="button"
      onClick={onLaunch}
      disabled={disabled}
      title={unavailable ? UNAVAILABLE_COPY[unavailable].title : undefined}
      aria-keyshortcuts={primaryCombo ?? undefined}
      className={cn(
        "focus-ring group flex items-start gap-3.5 rounded-[14px] border p-4 text-left transition-colors",
        disabled && "cursor-not-allowed opacity-60",
        action.featured
          ? "border-[color:var(--color-accent)] bg-[var(--color-accent-soft)]"
          : "border-[color:var(--hairline)] bg-[var(--color-surface)]",
        !disabled && !action.featured && "hover:bg-[var(--color-overlay-1)]"
      )}
    >
      <IconTile
        icon={action.icon}
        badge={action.badge}
        tint={action.tint}
        size={48}
      />
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] font-semibold text-[var(--color-ink)]">
          {action.title}
        </h3>
        <p className="mt-0.5 text-[12.5px] leading-snug text-[var(--color-slate)]">
          {action.description}
        </p>
        <div className="mt-2.5 flex items-center gap-1">
          {unavailable ? (
            <span className="rounded-[6px] bg-[var(--color-overlay-2)] px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-hint)]">
              {UNAVAILABLE_COPY[unavailable].pill}
            </span>
          ) : (
            keys.map((key, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && (
                  <span className="text-[11px] text-[var(--color-hint)]">
                    +
                  </span>
                )}
                <kbd className="rounded-[6px] border border-[color:var(--hairline-strong)] bg-[var(--color-overlay-1)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-slate)]">
                  {key}
                </kbd>
              </span>
            ))
          )}
        </div>
      </div>
    </button>
  );
}
