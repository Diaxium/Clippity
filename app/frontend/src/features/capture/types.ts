/**
 * Public types for the capture feature.
 *
 * Wire-format types (`CaptureType`, `CaptureRequest`, `CaptureResult`,
 * etc.) live in `@services/tauri/clients/capture` per ADR 0001 — this
 * file re-exports them so existing intra-feature imports
 * (`../types`) keep working, and adds the UI-only shapes the
 * components / hooks consume.
 */

import type { ComponentType } from "react";

// Re-export wire types from the IPC client (single source of truth).
export type {
  CaptureType,
  CustomMode,
  CaptureToggles,
  CaptureDelay,
  CaptureRequest,
  CaptureResult,
} from "@services/tauri/clients/capture";

// ---- UI-only types -------------------------------------------------

export type CaptureNav = "capture" | "record" | "history" | "presets";

/** Lucide icon component shape used by mode metadata. */
export type ModeIcon = ComponentType<{
  size?: number;
  strokeWidth?: number;
  className?: string;
}>;

export type ModeTint = "warm" | "cool";

/** Metadata for a single mode tile — drives both the type grid and the
 *  custom-modes panel. `available` controls whether the tile is armable
 *  in the current build; disabled tiles render with `unavailableHint`
 *  as a tooltip. */
export interface ModeDef<Id extends string> {
  id: Id;
  label: string;
  /** Description shown in tile body. Omitted on the compact type grid. */
  desc?: string;
  /** Four short "best for" chips shown on custom-mode tiles only. */
  bestFor?: readonly [string, string, string, string];
  icon: ModeIcon;
  tint: ModeTint;
  available: boolean;
  /** Tooltip when disabled — points at the responsible later port. */
  unavailableHint?: string;
}
