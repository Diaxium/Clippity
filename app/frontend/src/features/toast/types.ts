/**
 * Toast feature types. The wire types live in
 * `@services/tauri/clients/toast` (per ADR 0001 — typed IPC clients
 * that ≥2 features will call live under `services/tauri/clients/`).
 * Re-exported here so feature-internal components import from one
 * place.
 */

export type {
  PaletteSwatch,
  PickedColor,
  RecorderToastFormat,
  RecordingMode,
  ToastCorner,
  ToastDurations,
  ToastKind,
  ToastPayload,
  ToastShowEvent,
} from "@services/tauri/clients/toast";
