import { motion } from "motion/react";

import { cn } from "@shared/lib/cn";

import type { ModeDef } from "../types";
import { IconTile } from "./IconTile";

/** Tooltip for a mode this build implements but this installation omits. */
const NOT_INSTALLED_HINT =
  "This component wasn't selected when Clippity was installed. Re-run the installer and choose Modify to add it.";

interface ModeTileProps<Id extends string> {
  def: ModeDef<Id>;
  active: boolean;
  /** Show description + best-for chips. Compact tiles set this false. */
  showDetails?: boolean;
  /**
   * True when the mode is implemented but its component was declined at
   * install time (see `domain::provisioning`). Disables the tile like
   * `!def.available` does, but says "Not installed" — a different fact with
   * a different remedy, and the user's own past choice rather than a
   * shipping gap.
   */
  notInstalled?: boolean;
  onSelect: (id: Id) => void;
}

/**
 * Shared tile used by the top-level Capture Type grid and the
 * Custom-Modes panel. Disabled tiles render with `aria-disabled`,
 * dimmed opacity, and a badge saying why — "Soon" for a port that hasn't
 * landed (`def.unavailableHint` is the tooltip), "Not installed" for a
 * component the user declined.
 */
export function ModeTile<Id extends string>({
  def,
  active,
  showDetails = true,
  notInstalled = false,
  onSelect,
}: ModeTileProps<Id>) {
  const disabled = !def.available || notInstalled;
  // An unshipped port wins the explanation: it is the harder blocker, and
  // "re-run the installer" would be false advice for it.
  const badge = def.available && notInstalled ? "Not installed" : "Soon";
  const title = disabled
    ? def.available
      ? NOT_INSTALLED_HINT
      : def.unavailableHint
    : undefined;

  return (
    <motion.button
      type="button"
      onClick={() => onSelect(def.id)}
      disabled={disabled}
      aria-pressed={active}
      aria-disabled={disabled}
      title={title}
      whileHover={disabled ? undefined : { y: -2 }}
      whileTap={disabled ? undefined : { scale: 0.99 }}
      transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
      className={cn(
        "focus-ring relative flex h-full flex-col items-start gap-2 rounded-[12px] border p-3.5 text-left transition-shadow",
        active
          ? "border-[color:var(--color-accent)]/45 bg-[color:var(--color-accent-soft)] shadow-[0_4px_14px_color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
          : "border-[color:var(--hairline)] bg-[var(--color-surface)] hover:shadow-[var(--shadow-medium)]",
        disabled && "cursor-not-allowed opacity-55 hover:shadow-none"
      )}
    >
      {disabled && (
        <span className="absolute right-2 top-2 rounded-full bg-[color:var(--color-overlay-2)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-hint)]">
          {badge}
        </span>
      )}

      <IconTile icon={def.icon} tint={def.tint} />

      <span
        className={cn(
          "text-[13px] font-semibold",
          active ? "text-[var(--color-accent)]" : "text-[var(--color-ink)]"
        )}
      >
        {def.label}
      </span>

      {showDetails && def.desc && (
        <span className="text-[12px] leading-snug text-[var(--color-slate)]">
          {def.desc}
        </span>
      )}

      {showDetails && def.bestFor && (
        <span className="mt-auto flex flex-wrap gap-1 pt-1">
          {def.bestFor.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-[color:var(--color-overlay-1)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--color-hint)]"
            >
              {tag}
            </span>
          ))}
        </span>
      )}
    </motion.button>
  );
}
