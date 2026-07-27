//! Toast domain types — pure, no I/O.
//!
//! The toast surface is a small floating notification window pinned
//! to a corner of the cursor's monitor. The Step 2 architecture plan
//! pins the wire shape end-to-end as **kebab-case** so the legacy's
//! `kind.replace(/-/g, "_")` bridge hack disappears.
//!
//! MVP only routes the `Error` variant through `ToastService::show`.
//! The other five variants reserve their wire shape so a future port
//! (Color-Pick, etc.) can flip them armable without reshaping. The
//! reject happens at the service boundary, not here in the domain —
//! domain stays pure.

use serde::{Deserialize, Serialize};

/// Toast payload — discriminated by `kind`. All variants serialize
/// kebab-case (so `kind = "recording"` etc.).
///
/// **MVP**: only `Error` reaches `ToastService::show`. Other variants
/// are reserved for follow-up ports and rejected with
/// `AppError::Unsupported` at the service layer.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ToastPayload {
    /// MVP — universal failure surface.
    Error { message: String },

    /// Clipboard-mode capture finished. Reserved for the capture port's
    /// "tell me when a clipboard capture lands" flow + the editor port's
    /// Open Editor handoff.
    Clipboard {
        preview: String,
        width: u32,
        height: u32,
        /// Original plaintext, present only when the clipboard held text.
        text: Option<String>,
    },

    /// Reserved for Color-Pick custom-mode port.
    Color { color: PickedColor },

    /// Reserved for Palette-Capture custom-mode port.
    Palette {
        preview: String,
        colors: Vec<PaletteSwatch>,
    },

    /// Reserved for Grab-Text OCR custom-mode port.
    Text { text: String },

    /// Reserved for Scrolling/Panoramic recording-engine port.
    Recording { mode: RecordingMode, frames: u32 },

    /// The video/GIF recorder HUD (ADR 0031).
    ///
    /// Separate from `Recording` even though both are "a sticky toast
    /// with a stop button": that one counts stitched frames toward a
    /// still image and offers Stop & Stitch, this one runs a clock,
    /// offers pause/resume, and ends in a video file. Sharing a variant
    /// would mean a body component branching on which kind of recording
    /// it actually is on every render.
    Recorder {
        format: RecorderToastFormat,
        /// Whether an audio track was requested, so the HUD can show a
        /// level indicator rather than implying silence.
        audio: bool,
    },
}

/// Which output the running recorder session is producing — the HUD
/// labels itself with it, since a GIF session's ceilings differ enough
/// from an MP4's to be worth stating.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecorderToastFormat {
    Mp4,
    Gif,
}

/// Sampled color from the Color-Picker custom mode. Reserved.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PickedColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub hex: String,
}

/// Palette swatch from the Palette-Capture custom mode. `proportion` is
/// the swatch's share of the sampled region (0.0–1.0, dominant first),
/// mirrored from `library::AuxColor` so the toast can size swatches and
/// label their percentages. `Eq` is not derived — `proportion` is `f64`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaletteSwatch {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub hex: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proportion: Option<f64>,
}

/// Recording style. Reserved for the recording-engine port.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecordingMode {
    Scrolling,
    Panoramic,
}

/// Per-kind auto-dismiss timeouts in milliseconds. `0` means sticky
/// (user dismisses manually).
///
/// The kebab-case wire keys mirror the `ToastPayload::kind` shape so
/// the frontend can look up `durations[kind]` without a snake/kebab
/// bridge.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub struct ToastDurations {
    #[serde(default = "default_color_ms")]
    pub color: u64,
    #[serde(default = "default_palette_ms")]
    pub palette: u64,
    #[serde(default)]
    pub clipboard: u64,
    #[serde(default)]
    pub text: u64,
    #[serde(default)]
    pub recording: u64,
    #[serde(default = "default_error_ms")]
    pub error: u64,
}

fn default_color_ms() -> u64 {
    8000
}
fn default_palette_ms() -> u64 {
    9000
}
fn default_error_ms() -> u64 {
    6000
}

impl Default for ToastDurations {
    fn default() -> Self {
        Self {
            color: default_color_ms(),
            palette: default_palette_ms(),
            clipboard: 0,
            text: 0,
            recording: 0,
            error: default_error_ms(),
        }
    }
}

impl ToastDurations {
    /// Look up the auto-dismiss duration for a payload kind. `0`
    /// signals sticky (no auto-dismiss).
    pub fn for_payload(&self, payload: &ToastPayload) -> u64 {
        match payload {
            ToastPayload::Error { .. } => self.error,
            ToastPayload::Clipboard { .. } => self.clipboard,
            ToastPayload::Color { .. } => self.color,
            ToastPayload::Palette { .. } => self.palette,
            ToastPayload::Text { .. } => self.text,
            ToastPayload::Recording { .. } => self.recording,
            // Sticky, and not user-configurable: the recorder HUD is
            // the only way to stop a running recording. A timeout that
            // dismissed it would strand a session with no way to end it
            // short of quitting the app.
            ToastPayload::Recorder { .. } => 0,
        }
    }
}

/// Anchor corner of the cursor's monitor's work area.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ToastCorner {
    #[default]
    BottomRight,
    BottomLeft,
    TopRight,
    TopLeft,
}

/// Default toast settings — hardcoded for MVP. Swap to a
/// settings-accessor injection when settings port #6 lands. Values
/// mirror the legacy `FALLBACK_DURATIONS` exactly so the toast feels
/// familiar.
#[derive(Clone, Debug)]
pub struct ToastDefaults {
    pub corner: ToastCorner,
    pub durations: ToastDurations,
}

impl ToastDefaults {
    pub fn defaults() -> Self {
        Self {
            corner: ToastCorner::default(),
            durations: ToastDurations::default(),
        }
    }
}

impl Default for ToastDefaults {
    fn default() -> Self {
        Self::defaults()
    }
}

// ---------- Pure geometry helpers ----------

/// Anchor a `size`-sized rectangle against `corner` of the work-area
/// rect `(wx, wy, ww, wh)`, with `gap` physical-pixel breathing room
/// from the edge. Returns the resulting `(x, y)` top-left position.
///
/// Pure: unit-testable without an `AppHandle`.
pub fn anchor_to_corner(
    work: (i32, i32, i32, i32),
    size: (u32, u32),
    corner: ToastCorner,
    gap: i32,
) -> (i32, i32) {
    let (wx, wy, ww, wh) = work;
    let (sw, sh) = (size.0 as i32, size.1 as i32);
    let right_x = wx + ww - sw - gap;
    let left_x = wx + gap;
    let bottom_y = wy + wh - sh - gap;
    let top_y = wy + gap;
    match corner {
        ToastCorner::BottomLeft => (left_x, bottom_y),
        ToastCorner::TopRight => (right_x, top_y),
        ToastCorner::TopLeft => (left_x, top_y),
        ToastCorner::BottomRight => (right_x, bottom_y),
    }
}

/// Defend the OS API against runaway content measurements. Width and
/// height are logical pixels.
pub fn clamp_size(width: f64, height: f64) -> (f64, f64) {
    let w = width.clamp(MIN_WIDTH, MAX_WIDTH);
    let h = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    (w, h)
}

/// Sanity bounds inherited from legacy — see `ToastWindow.tsx`
/// constants. Frontend clamps too; backend enforces against bad IPC.
pub const MIN_WIDTH: f64 = 280.0;
pub const MAX_WIDTH: f64 = 720.0;
pub const MIN_HEIGHT: f64 = 96.0;
pub const MAX_HEIGHT: f64 = 480.0;

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- ToastPayload serde round-trips ----------

    #[test]
    fn error_payload_serializes_kebab_case_with_kind_tag() {
        let p = ToastPayload::Error {
            message: "boom".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        // Internally tagged on `kind`; kebab-case rename means "error"
        // (which has no dashes) is unchanged, but the discriminant
        // proves the serde shape.
        assert_eq!(s, r#"{"kind":"error","message":"boom"}"#);
    }

    #[test]
    fn error_payload_round_trips() {
        let original = ToastPayload::Error {
            message: "boom".into(),
        };
        let s = serde_json::to_string(&original).unwrap();
        let back: ToastPayload = serde_json::from_str(&s).unwrap();
        assert_eq!(original, back);
    }

    #[test]
    fn recording_mode_serializes_kebab() {
        let p = ToastPayload::Recording {
            mode: RecordingMode::Scrolling,
            frames: 3,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains(r#""mode":"scrolling""#));
    }

    // ---------- ToastDurations behaviour ----------

    #[test]
    fn for_payload_resolves_error_duration() {
        let d = ToastDefaults::defaults().durations;
        let dur = d.for_payload(&ToastPayload::Error {
            message: "x".into(),
        });
        assert_eq!(dur, 6000);
    }

    #[test]
    fn for_payload_resolves_sticky_kinds_to_zero() {
        let d = ToastDefaults::defaults().durations;
        assert_eq!(d.for_payload(&ToastPayload::Text { text: "".into() }), 0);
        assert_eq!(
            d.for_payload(&ToastPayload::Recording {
                mode: RecordingMode::Scrolling,
                frames: 0
            }),
            0
        );
    }

    #[test]
    fn defaults_mirror_legacy_fallbacks() {
        let d = ToastDefaults::defaults().durations;
        assert_eq!(d.color, 8000);
        assert_eq!(d.palette, 9000);
        assert_eq!(d.error, 6000);
        assert_eq!(d.clipboard, 0);
        assert_eq!(d.text, 0);
        assert_eq!(d.recording, 0);
    }

    // ---------- anchor_to_corner ----------

    #[test]
    fn anchor_bottom_right_against_1920x1080_work_area() {
        let (x, y) = anchor_to_corner((0, 0, 1920, 1080), (380, 156), ToastCorner::BottomRight, 12);
        assert_eq!(x, 1920 - 380 - 12);
        assert_eq!(y, 1080 - 156 - 12);
    }

    #[test]
    fn anchor_bottom_left() {
        let (x, y) = anchor_to_corner((0, 0, 1920, 1080), (380, 156), ToastCorner::BottomLeft, 12);
        assert_eq!(x, 12);
        assert_eq!(y, 1080 - 156 - 12);
    }

    #[test]
    fn anchor_top_right() {
        let (x, y) = anchor_to_corner((0, 0, 1920, 1080), (380, 156), ToastCorner::TopRight, 12);
        assert_eq!(x, 1920 - 380 - 12);
        assert_eq!(y, 12);
    }

    #[test]
    fn anchor_top_left() {
        let (x, y) = anchor_to_corner((0, 0, 1920, 1080), (380, 156), ToastCorner::TopLeft, 12);
        assert_eq!(x, 12);
        assert_eq!(y, 12);
    }

    #[test]
    fn bottom_anchor_grows_upward_keeping_bottom_edge_pinned() {
        // The recording HUD grows when it gains its live preview. Anchored
        // to a bottom corner it must grow *upward* — the bottom edge stays
        // one gap above the work-area bottom (never sliding under the
        // taskbar), which only holds when the anchor is fed the real new
        // height. Regression guard for the toast resize race.
        let work = (0, 0, 1920, 1080);
        let (_, y_short) = anchor_to_corner(work, (380, 96), ToastCorner::BottomRight, 12);
        let (_, y_tall) = anchor_to_corner(work, (380, 240), ToastCorner::BottomRight, 12);
        assert_eq!(
            y_short + 96,
            y_tall + 240,
            "bottom edge stays pinned as it grows"
        );
        assert_eq!(
            y_tall + 240,
            1080 - 12,
            "bottom sits one gap above the work area"
        );
        assert!(
            y_tall < y_short,
            "the taller toast's top is higher — it grew upward"
        );
    }

    #[test]
    fn anchor_respects_work_area_offset() {
        // Secondary monitor at (1920, 0) with a 100px taskbar at top.
        let (x, y) = anchor_to_corner(
            (1920, 100, 1920, 980),
            (380, 156),
            ToastCorner::BottomRight,
            12,
        );
        assert_eq!(x, 1920 + 1920 - 380 - 12);
        assert_eq!(y, 100 + 980 - 156 - 12);
    }

    // ---------- clamp_size ----------

    #[test]
    fn clamp_size_in_range_passes_through() {
        let (w, h) = clamp_size(380.0, 240.0);
        assert_eq!(w, 380.0);
        assert_eq!(h, 240.0);
    }

    #[test]
    fn clamp_size_clamps_too_small() {
        let (w, h) = clamp_size(100.0, 40.0);
        assert_eq!(w, MIN_WIDTH);
        assert_eq!(h, MIN_HEIGHT);
    }

    #[test]
    fn clamp_size_clamps_too_large() {
        let (w, h) = clamp_size(2000.0, 1000.0);
        assert_eq!(w, MAX_WIDTH);
        assert_eq!(h, MAX_HEIGHT);
    }
}
