//! Services — anything that touches the outside world.
//!
//! Filesystems, capture APIs, OCR engines, native windows, clipboards.
//! Each service performs I/O and is wired into the app's `AppState` at the
//! `src-tauri` layer. Depends on `clippity-domain`, `clippity-infra`, and
//! `clippity-platform`.
//!
//!   capture_service   — fullscreen primary-monitor capture
//!   overlay_service   — interactive region overlay (snapshot + crop)
//!   toast_service     — floating notification window lifecycle
//!   library_service   — captures inventory (list + thumb + trash + tags)
//!   collections_service — named, ordered capture sets
//!   library_index     — SQLite cache over the capture files + `.meta`
//!   editor_service    — load a capture as data URI + save flattened PNG
//!   media_service     — describe a saved recording + hand its bytes to
//!                       the Studio player (the streaming counterpart)
//!   presets_service   — user-defined capture presets (presets.json CRUD)
//!   last_region_store — remembers the last rectangular selection
//!   window_service    — shared show/hide/restore primitives
//!   capture_io        — post-capture PNG / clipboard / id helpers
//!   ocr_service       — Grab Text via Windows.Media.Ocr
//!   provisioning_service — the installer's choices → feature availability
//!   settings_service  — settings load/save
//!   sidecar           — per-capture `.meta` / `.scenes` / `.labels` records
//!   share_service     — hand a saved capture to the OS
//!   scroll_capture_service — scrolling / panoramic stitch recording
//!   recorder_service  — video / GIF screen recording (ADR 0031)
//!   countdown_service — the pre-capture countdown strip
//!   diagnostics_service — what Settings → Advanced reads, and the
//!                       redacted bundle it exports

pub mod capture_io;
pub mod capture_service;
pub mod collections_service;
pub mod countdown_service;
pub mod diagnostics_service;
pub mod editor_service;
pub mod global_shortcut_service;
pub mod last_region_store;
pub mod library_index;
pub mod library_service;
pub mod media_service;
pub mod ocr_service;
pub mod overlay_service;
pub mod presets_service;
pub mod provisioning_service;
pub mod recorder_service;
pub mod scroll_capture_service;
pub mod settings_service;
pub mod share_service;
pub mod sidecar;
pub mod toast_service;
pub mod window_service;
