/**
 * Home feature types.
 *
 * The Home view is the dashboard's landing overview. Its cards are fed
 * from live backend data (library listing, presets, storage, app
 * version) via the hooks in `./hooks`, so the section shapes are the
 * wire types from `@clippity/shared` — these are just the small
 * presentational primitives shared across the cards.
 */

import type { ComponentType } from "react";

/** Minimal icon component signature shared by every lucide icon. */
export type IconComponent = ComponentType<{
  size?: number;
  strokeWidth?: number;
  className?: string;
}>;

/** Accent tint families available to icon tiles (map to `--color-tile-*`). */
export type TileTint = "warm" | "cool" | "violet" | "gold";

/** Rotating tile tints, so a list of items reads as a small multi-hue set. */
export const TILE_TINTS: readonly TileTint[] = ["warm", "cool", "violet", "gold"];

/** Pick a stable tint for list position `i`. */
export function tintForIndex(i: number): TileTint {
  return TILE_TINTS[i % TILE_TINTS.length]!;
}
