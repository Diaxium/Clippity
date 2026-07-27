/**
 * Quick-capture launcher definitions — the single source of truth for
 * the four cards on the Home view and their keyboard shortcuts.
 *
 * Each action carries an author combo (`Mod+1`, …) parsed through the
 * shared keybind primitives, so the on-card shortcut chips
 * (`formatCombo`) and the live hotkey matcher (`comboSigKey` vs.
 * `eventSigKey`) can never drift apart.
 *
 * All four map to a real backend capability: Screenshot and Window open
 * the region / window overlays, Record and GIF start a screen recording
 * (ADR 0031). The `available: false` path — a "Soon" pill and no
 * shortcut — is kept for whatever lands next rather than removed.
 *
 * Record and GIF start on the monitor under the cursor. Recording a
 * chosen region goes through the overlay instead, so it is not a
 * one-click launcher action.
 */

import { AppWindow, ScanLine } from "lucide-react";

import type { Capabilities } from "@services/tauri/clients/provisioning";

import type { IconComponent, TileTint } from "../types";

/** Stable ids the dispatch hook switches on. */
export type QuickCaptureId = "screenshot" | "window" | "record" | "gif";

export interface QuickCaptureAction {
  id: QuickCaptureId;
  title: string;
  description: string;
  /** Rendered inside the tile — a lucide icon or a short text badge. */
  icon?: IconComponent;
  badge?: string;
  tint: TileTint;
  /** Author combo (`Mod+1`). Present only for available actions. */
  combo?: string;
  /** False = no backend yet; card renders a "Soon" pill, no hotkey. */
  available: boolean;
  /** The screenshot launcher is the featured/primary card. */
  featured?: boolean;
}

export const QUICK_CAPTURE_ACTIONS: readonly QuickCaptureAction[] = [
  {
    id: "screenshot",
    title: "Screenshot",
    description: "Capture any part of your screen",
    icon: ScanLine,
    tint: "warm",
    combo: "Mod+1",
    available: true,
    featured: true,
  },
  {
    id: "window",
    title: "Window",
    description: "Capture a specific window or app",
    icon: AppWindow,
    tint: "cool",
    combo: "Mod+2",
    available: true,
  },
  {
    id: "record",
    title: "Record",
    description: "Record your screen to video",
    badge: "REC",
    tint: "violet",
    combo: "Mod+3",
    available: true,
  },
  {
    id: "gif",
    title: "GIF",
    description: "Record your screen as a looping GIF",
    badge: "GIF",
    tint: "gold",
    combo: "Mod+4",
    available: true,
  },
];

/** Why a launcher action can't be used right now. */
export type Unavailability =
  /** The port hasn't landed — the card's historic "Soon" state. */
  | "soon"
  /** The component was declined when Clippity was installed. Fixable by
   *  re-running the installer's Modify flow, which the card says. */
  | "not-installed";

/**
 * Why `action` is unusable, or `null` when it is fine.
 *
 * Pure, and the single place the two facts are combined: the card renders
 * from it and the hotkey map filters on it, so a key can never fire an
 * action whose card is disabled. `capabilities` only gates GIF today —
 * everything else the launcher offers is part of `core`.
 */
export function unavailabilityOf(
  action: QuickCaptureAction,
  capabilities: Capabilities
): Unavailability | null {
  if (!action.available) return "soon";
  if (action.id === "gif" && !capabilities.gifRecording) return "not-installed";
  return null;
}
