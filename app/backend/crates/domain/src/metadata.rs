//! Capture **provenance** — what we knew about a capture at the moment
//! it was written to disk. Pure: no I/O, no platform code, no clock.
//!
//! The filesystem stays the source of truth for the library (a capture
//! *is* its file). This module describes the small JSON record that
//! rides alongside each one so the library can answer questions the
//! pixels can't: which app was on screen, which mode produced it, how
//! big it is, and when it was actually taken — as opposed to whenever
//! the file was last touched.
//!
//! Two types, and the split matters:
//!
//! - [`CaptureSource`] is the **input**: borrowed, `Copy`, assembled by
//!   whichever pipeline is about to save. It is also what
//!   `domain::naming` renders a file name from, so a capture's name and
//!   its metadata can never disagree about where it came from — they
//!   read the same struct.
//! - [`CaptureMetadata`] is the **record**: owned, serde, versioned,
//!   written next to the capture by `services::sidecar`.
//!
//! Every field is optional except the ones a capture cannot lack (mode,
//! timestamp). A field we cannot honestly resolve is absent, never
//! guessed — a sparse record is a true record, and the library renders
//! what is there.

use serde::{Deserialize, Serialize};

/// On-disk schema version for [`CaptureMetadata`]. Bump when a change
/// can't be expressed as "add an optional field"; readers treat an
/// unknown-but-parseable record as usable, so additive changes need no
/// bump.
pub const SCHEMA_VERSION: u32 = 1;

/// Where a capture came from, as known at save time. Borrowed and
/// `Copy` so a pipeline can build one on the stack next to the pixels
/// it just produced.
///
/// `type_label` is the capture mode's display name (`Region`,
/// `Fullscreen`, `Scrolling`, `Edited`, …) — the same string the
/// file-name template's `{type}` token renders. `window` and `app` are
/// the raw (unsanitised) dominant-window title and its owning
/// application; either can be `None` when attribution found nothing.
#[derive(Debug, Clone, Copy, Default)]
pub struct CaptureSource<'a> {
    /// Dominant captured-window title, unsanitised. `None` when window
    /// attribution found nothing (a capture of the desktop, say).
    pub window: Option<&'a str>,
    /// Friendly name of the application owning `window`. Resolved from
    /// the executable, so it is `None` on the same paths `window` is —
    /// and additionally when the process could not be queried.
    pub app: Option<&'a str>,
    /// Capture-mode display label. Never empty in practice; the namer
    /// substitutes a generic label if it ever were.
    pub type_label: &'a str,
    /// Pixel dimensions of the saved image, when the caller decoded or
    /// produced them. The editor's export path does not (it persists
    /// opaque encoded bytes), so this stays `None` there rather than
    /// paying a decode just to fill a metadata field.
    pub size: Option<(u32, u32)>,
    /// Display the captured pixels came from, already formatted for
    /// reading by [`monitor_label`]. Resolved by area attribution over
    /// the capture rect, so a selection straddling two screens records
    /// the one it mostly sits on. `None` when the capture has no screen
    /// of origin at all — a clipboard ingest, an editor export.
    pub monitor: Option<&'a str>,
    /// Name of the capture preset that produced this, when a preset did.
    /// The backend cannot infer it: presets are executed by the
    /// frontend's `runPreset` orchestrator, so this arrives as a request
    /// field and is `None` for every interactive capture.
    pub preset: Option<&'a str>,
}

impl<'a> CaptureSource<'a> {
    /// A source that knows only which mode produced the capture — the
    /// floor every pipeline can meet.
    pub fn from_mode(type_label: &'a str) -> Self {
        Self {
            window: None,
            app: None,
            type_label,
            size: None,
            monitor: None,
            preset: None,
        }
    }

    /// Attach the attributed window (and its app, when resolved).
    pub fn with_window(mut self, window: Option<&'a str>, app: Option<&'a str>) -> Self {
        self.window = window;
        self.app = app;
        self
    }

    /// Attach the saved image's pixel dimensions.
    pub fn with_size(mut self, width: u32, height: u32) -> Self {
        self.size = Some((width, height));
        self
    }

    /// Attach the display the pixels came from — see [`monitor_label`]
    /// for the shape of the string.
    pub fn with_monitor(mut self, monitor: Option<&'a str>) -> Self {
        self.monitor = monitor;
        self
    }

    /// Attach the name of the preset that ran this capture.
    pub fn with_preset(mut self, preset: Option<&'a str>) -> Self {
        self.preset = preset;
        self
    }
}

/// Turn a platform display-device name into the label the record stores
/// and the library shows.
///
/// Windows names its displays `\\.\DISPLAY1`, `\\.\DISPLAY2`, … — the
/// same ordinal Display Settings puts on screen as "1", "2". So the
/// device name already carries the number the user recognises; this only
/// re-spells it as `Display 2`. Anything that doesn't match that shape
/// (another platform, a virtual adapter) is passed through trimmed
/// rather than reformatted into a lie, and a blank name is `None` — the
/// same "absent, never guessed" rule the rest of the record follows.
///
/// Deliberately *not* the monitor's marketing name. Resolving that costs
/// a `DisplayConfig` round-trip and lands on strings like "Generic PnP
/// Monitor" or "Unknown Monitor 65537", which are neither stable nor
/// recognisable — the same argument ADR 0026 used for taking an
/// application's executable stem over its version-resource name.
pub fn monitor_label(device_name: &str) -> Option<String> {
    let name = device_name.trim();
    if name.is_empty() {
        return None;
    }
    let bare = name.strip_prefix(r"\\.\").unwrap_or(name);
    let ordinal = bare
        .strip_prefix("DISPLAY")
        .or_else(|| bare.strip_prefix("display"))
        .filter(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()));
    Some(match ordinal {
        Some(n) => format!("Display {n}"),
        None => name.to_owned(),
    })
}

/// The persisted provenance record for one capture, written as
/// `<dir>/.meta/<file name>.json` by `services::sidecar`.
///
/// `file` names the capture the record describes. It is deliberately a
/// bare file name rather than a path: sidecars travel with their
/// capture (trash, restore, a preset's output folder), so an absolute
/// path would be stale the first time the file moved, while the name
/// stays true and lets a reader detect a mismatched pairing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMetadata {
    /// [`SCHEMA_VERSION`] at write time.
    pub version: u32,
    /// File name (with extension) of the capture this describes.
    pub file: String,
    /// Capture-mode label — `CaptureSource::type_label`.
    pub mode: String,
    /// Wall-clock instant the capture was saved, epoch milliseconds.
    /// Distinct from the file's mtime, which any later touch rewrites.
    pub captured_at_ms: u128,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_window: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Display the pixels came from — `CaptureSource::monitor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor: Option<String>,
    /// Name of the capture preset that ran, when one did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
}

/// Build the record for a capture that has just been written as
/// `file_name`, taken at `captured_at_ms`.
///
/// Blank strings collapse to `None`: an empty window title is the same
/// non-answer as a missing one, and storing `""` would make every
/// downstream `is_some()` check lie.
pub fn build(source: &CaptureSource, file_name: &str, captured_at_ms: u128) -> CaptureMetadata {
    let (width, height) = match source.size {
        Some((w, h)) => (Some(w), Some(h)),
        None => (None, None),
    };
    CaptureMetadata {
        version: SCHEMA_VERSION,
        file: file_name.to_owned(),
        mode: source.type_label.to_owned(),
        captured_at_ms,
        source_app: non_blank(source.app),
        source_window: non_blank(source.window),
        width,
        height,
        monitor: non_blank(source.monitor),
        preset: non_blank(source.preset),
    }
}

/// Trim and drop empties — see [`build`].
fn non_blank(s: Option<&str>) -> Option<String> {
    s.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> CaptureSource<'static> {
        CaptureSource::from_mode("Region")
            .with_window(Some("GitHub - PR #42 - Chrome"), Some("Chrome"))
            .with_size(1920, 1080)
            .with_monitor(Some("Display 2"))
            .with_preset(Some("Docs shot"))
    }

    #[test]
    fn build_carries_every_known_field() {
        let m = build(&source(), "Shot.png", 1_700_000_000_000);
        assert_eq!(m.version, SCHEMA_VERSION);
        assert_eq!(m.file, "Shot.png");
        assert_eq!(m.mode, "Region");
        assert_eq!(m.captured_at_ms, 1_700_000_000_000);
        assert_eq!(m.source_app.as_deref(), Some("Chrome"));
        assert_eq!(m.source_window.as_deref(), Some("GitHub - PR #42 - Chrome"));
        assert_eq!((m.width, m.height), (Some(1920), Some(1080)));
        assert_eq!(m.monitor.as_deref(), Some("Display 2"));
        assert_eq!(m.preset.as_deref(), Some("Docs shot"));
    }

    #[test]
    fn build_from_mode_alone_leaves_the_rest_absent() {
        let m = build(&CaptureSource::from_mode("Edited"), "E.webp", 42);
        assert_eq!(m.mode, "Edited");
        assert_eq!(m.source_app, None);
        assert_eq!(m.source_window, None);
        assert_eq!((m.width, m.height), (None, None));
        // An interactive capture ran no preset, and an editor export has
        // no screen of origin — both stay absent rather than guessed.
        assert_eq!(m.monitor, None);
        assert_eq!(m.preset, None);
    }

    #[test]
    fn monitor_label_reads_the_windows_display_ordinal() {
        // The ordinal in the device name is the number Display Settings
        // shows, so the label is just a re-spelling of it.
        assert_eq!(monitor_label(r"\\.\DISPLAY1").as_deref(), Some("Display 1"));
        assert_eq!(
            monitor_label(r"\\.\DISPLAY12").as_deref(),
            Some("Display 12")
        );
        // Some callers hand over the bare device name.
        assert_eq!(monitor_label("DISPLAY3").as_deref(), Some("Display 3"));
    }

    #[test]
    fn monitor_label_passes_unrecognised_names_through() {
        // Another platform, or a virtual adapter: pass it through rather
        // than reformatting it into a number it doesn't have.
        assert_eq!(monitor_label("  HDMI-A-1  ").as_deref(), Some("HDMI-A-1"));
        // "DISPLAY" with a non-numeric tail is not an ordinal.
        assert_eq!(
            monitor_label(r"\\.\DISPLAYLINK").as_deref(),
            Some(r"\\.\DISPLAYLINK")
        );
    }

    #[test]
    fn monitor_label_of_nothing_is_absent() {
        assert_eq!(monitor_label(""), None);
        assert_eq!(monitor_label("   "), None);
    }

    #[test]
    fn a_preset_name_is_recorded_verbatim() {
        // Unlike the file name, the record is not a filesystem path — a
        // preset called "Region → Slack" keeps its punctuation.
        let src = CaptureSource::from_mode("Region").with_preset(Some("Region → Slack"));
        assert_eq!(
            build(&src, "S.png", 0).preset.as_deref(),
            Some("Region → Slack")
        );
    }

    #[test]
    fn blank_attribution_is_absent_not_empty() {
        // A whitespace-only title is the same non-answer as no title;
        // storing "" would make every downstream is_some() check lie.
        let src = CaptureSource::from_mode("Region").with_window(Some("   "), Some(""));
        let m = build(&src, "S.png", 0);
        assert_eq!(m.source_window, None);
        assert_eq!(m.source_app, None);
    }

    #[test]
    fn attribution_is_trimmed() {
        let src =
            CaptureSource::from_mode("Region").with_window(Some("  Notepad  "), Some(" Notepad "));
        let m = build(&src, "S.png", 0);
        assert_eq!(m.source_window.as_deref(), Some("Notepad"));
        assert_eq!(m.source_app.as_deref(), Some("Notepad"));
    }

    #[test]
    fn round_trips_camel_case() {
        let m = build(&source(), "Shot.png", 1_700_000_000_000);
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains(r#""capturedAtMs":1700000000000"#), "{json}");
        assert!(json.contains(r#""sourceApp":"Chrome""#), "{json}");
        assert!(json.contains(r#""sourceWindow""#), "{json}");
        let back: CaptureMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn absent_fields_are_skipped_not_null() {
        let m = build(&CaptureSource::from_mode("Fullscreen"), "F.png", 7);
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("sourceApp"), "{json}");
        assert!(!json.contains("width"), "{json}");
        assert!(!json.contains("monitor"), "{json}");
        assert!(!json.contains("preset"), "{json}");
        // The always-present fields survive.
        assert!(json.contains(r#""mode":"Fullscreen""#), "{json}");
    }

    #[test]
    fn a_record_missing_every_optional_field_still_parses() {
        // Forward/backward compatibility: the optional half is
        // `serde(default)`, so a minimal record written by an older or
        // sparser writer is readable.
        let json = r#"{"version":1,"file":"A.png","mode":"Region","capturedAtMs":5}"#;
        let m: CaptureMetadata = serde_json::from_str(json).unwrap();
        assert_eq!(m.file, "A.png");
        assert_eq!(m.source_app, None);
        assert_eq!(m.width, None);
    }

    #[test]
    fn source_builders_compose_in_any_order() {
        let a = CaptureSource::from_mode("Window")
            .with_size(4, 3)
            .with_preset(Some("P"))
            .with_window(Some("W"), Some("App"))
            .with_monitor(Some("Display 1"));
        let b = CaptureSource::from_mode("Window")
            .with_monitor(Some("Display 1"))
            .with_window(Some("W"), Some("App"))
            .with_preset(Some("P"))
            .with_size(4, 3);
        assert_eq!(build(&a, "x.png", 1), build(&b, "x.png", 1));
    }
}
