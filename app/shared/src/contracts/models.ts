/**
 * AI-model manager wire-format contracts — mirror Rust `domain::models`.
 */

/** What a model is for. Only object detection ships today. */
export type ModelTask = "object-detection";

/** Install/download phase — the discriminant of the flattened status
 *  fields on `ModelInfo`. `update-available` means a complete but older
 *  release is on disk and the registry has newer bytes. */
export type ModelPhase =
  "not-installed" | "downloading" | "installed" | "update-available" | "error";

/** One registry model + its live status. `downloaded`/`total` are only
 *  present while `phase === "downloading"`; `message` only when
 *  `phase === "error"`. */
export interface ModelInfo {
  id: string;
  label: string;
  description: string;
  task: ModelTask;
  /** Latest registry version Clippity can fetch (e.g. "1", "2"). */
  version: string;
  /** What's actually on disk: a release tag (e.g. "onnx-v3") or registry
   *  version. Absent when nothing is installed. */
  installedVersion?: string;
  /** Whether this model is checked against a live GitHub release. */
  checkable: boolean;
  sizeBytes: number;
  /** Short size/speed hint rendered next to the label. */
  hint: string;
  phase: ModelPhase;
  downloaded?: number;
  total?: number;
  message?: string;
}

/** Live verdict from a GitHub-release check (one per reachable
 *  GitHub-hosted model). Best-effort. Mirrors Rust `domain::models::ReleaseCheck`. */
export interface ReleaseCheck {
  id: string;
  /** Tag of GitHub's latest published release, e.g. "onnx-v3". */
  latestTag: string;
  /** ISO-8601 publish timestamp of that release. */
  publishedAt: string;
  /** Web URL of the release page. */
  htmlUrl: string;
  /** Whether anything is on disk for this model. */
  installed: boolean;
  /** Whether the installed bytes match the latest release. */
  installedIsLatest: boolean;
  /** Whether a live update can actually be fetched. Gates "Update". */
  updatable: boolean;
}

/** Payload of `clippity://models/progress` — throttled download ticks. */
export interface ModelProgress {
  id: string;
  downloaded: number;
  total: number;
}

/** Verdict of `ensure_object_model` — the capture window branches on
 *  `status` before opening the overlay in Object mode. */
export interface ObjectModelReadiness {
  status: "ready" | "downloading" | "missing";
  model: ModelInfo;
}
