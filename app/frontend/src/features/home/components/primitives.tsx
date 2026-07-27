/**
 * Small presentational building blocks shared across the Home cards.
 *
 * Everything resolves through the design-system tokens in `theme.css`
 * (`--color-surface`, `--hairline`, the `--color-tile-*` family, …) so
 * the whole view flips cleanly between light and dark and follows the
 * user's chosen accent.
 */

import type { ReactNode } from "react";

import { cn } from "@shared/lib/cn";

import type { IconComponent, TileTint } from "../types";

/** Tailwind arbitrary-value pairs for each tile tint → bg + foreground. */
const TILE_TINT: Record<TileTint, string> = {
  warm: "bg-[var(--color-tile-warm)] text-[var(--color-tile-warm-ink)]",
  cool: "bg-[var(--color-tile-cool)] text-[var(--color-tile-cool-ink)]",
  violet: "bg-[var(--color-tile-violet)] text-[var(--color-tile-violet-ink)]",
  gold: "bg-[var(--color-tile-gold)] text-[var(--color-tile-gold-ink)]",
};

interface SectionCardProps {
  className?: string;
  children: ReactNode;
}

/**
 * The recessed-surface card every Home block sits inside. A hair
 * lighter than the content canvas with a hairline border, so the cards
 * read as raised slabs on the inset backdrop in both themes.
 */
export function SectionCard({ className, children }: SectionCardProps) {
  return (
    <section
      className={cn(
        "flex flex-col rounded-[16px] border border-[color:var(--hairline)]",
        "bg-[var(--color-surface)] p-5 shadow-[var(--shadow-subtle)]",
        className
      )}
    >
      {children}
    </section>
  );
}

interface SectionHeadingProps {
  title: string;
  /** Optional right-aligned action (a "View all" / "Manage" link, a badge). */
  action?: ReactNode;
  className?: string;
}

/** Card header: a title on the left, an optional action on the right. */
export function SectionHeading({
  title,
  action,
  className,
}: SectionHeadingProps) {
  return (
    <div className={cn("flex items-center justify-between", className)}>
      <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">
        {title}
      </h2>
      {action}
    </div>
  );
}

interface LinkActionProps {
  label: string;
  onClick?: () => void;
}

/** Accent "View all" / "Manage" text link used in card headers. */
export function LinkAction({ label, onClick }: LinkActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring rounded-[6px] text-[13px] font-medium text-[var(--color-accent)] transition-opacity hover:opacity-80"
    >
      {label}
    </button>
  );
}

/** Muted single-line placeholder for a card with no data yet. */
export function CardEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="py-6 text-center text-[12.5px] text-[var(--color-hint)]">
      {children}
    </p>
  );
}

interface IconTileProps {
  icon?: IconComponent;
  /** Short glyph text (e.g. "REC" / "GIF") when there's no icon. */
  badge?: string;
  tint: TileTint;
  /** Tile edge length in px. */
  size?: number;
  /** Icon size in px (defaults scale with the tile). */
  iconSize?: number;
  className?: string;
}

/**
 * Rounded, tinted square holding an icon or a short text badge — the
 * launcher glyphs, preset markers, and activity dots all use it.
 */
export function IconTile({
  icon: Icon,
  badge,
  tint,
  size = 40,
  iconSize,
  className,
}: IconTileProps) {
  return (
    <span
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-[12px]",
        TILE_TINT[tint],
        className
      )}
      style={{ width: size, height: size }}
    >
      {Icon ? (
        <Icon size={iconSize ?? Math.round(size * 0.46)} strokeWidth={1.9} />
      ) : (
        <span className="text-[11px] font-bold tracking-wide">{badge}</span>
      )}
    </span>
  );
}
