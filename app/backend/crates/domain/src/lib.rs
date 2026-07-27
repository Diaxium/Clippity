//! Domain layer — pure types and rules. **No I/O, no Tauri**.
//!
//! Everything in here must be unit-testable without a desktop session,
//! a filesystem, or a window. If a type needs an external dependency
//! to be useful (beyond pure `image` math), it belongs in a service.
//!
//! Sub-modules are one per feature:
//!   capture   — fullscreen capture modes + requests
//!   overlay   — region geometry, overlay modes, finalize requests
//!   toast     — toast payloads, durations, corner anchor helpers
//!   library   — captured-item metadata + storage info
//!   metadata  — per-capture provenance (source app/window, mode, time)
//!   labels    — per-capture tags + favorite flag
//!   collections — named, ordered capture sets
//!   editor    — load/save data-URI envelope for the annotation editor
//!   naming    — capture file-name template engine
//!   provisioning — the installer's recorded choices + the feature
//!                  availability they imply
//!   recorder  — screen-recording requests, status, timing + GIF math
//!   settings  — settings schema + validation
//!   share     — where a saved capture can be handed off to
//!   models    — on-device AI model registry + status wire types
//!   vision    — object-detection post-processing (decode, NMS, tiling)
//!   window_attribution — visible-window majority scoring for names

pub mod capture;
pub mod collections;
pub mod countdown;
pub mod dashboard;
pub mod editor;
pub mod enhance;
pub mod labels;
pub mod library;
pub mod metadata;
pub mod models;
pub mod naming;
pub mod overlay;
pub mod palette;
pub mod preset;
pub mod provisioning;
pub mod recorder;
pub mod scroll;
pub mod settings;
pub mod share;
pub mod toast;
pub mod vision;
pub mod window_attribution;
