//! Capture domain types — the pure shape of a capture request, its
//! options, and its result. Shared by `services::capture_service` and
//! the typed IPC surface in `app::commands`.
//!
//! No I/O, no Tauri, no platform code. Unit-testable on its own.

use serde::{Deserialize, Serialize};

/// Top-level capture mode. `Custom` defers to [`CustomMode`] for the
/// specific sub-flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureKind {
    Region,
    Window,
    Fullscreen,
    Custom,
}

/// The custom sub-modes from the legacy product. Most are not yet
/// implemented in the rebuild — see [`AppError::Unsupported`] in
/// `capture_service::execute` for the rejection path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CustomMode {
    Object,
    MultiArea,
    Freehand,
    Clipboard,
    ScrollingWindow,
    Panoramic,
    GrabText,
    ColorPicker,
    PaletteCapture,
}

/// User-facing capture options. Mapped 1:1 from the four toggles in
/// the capture window's options panel; `delay` is split into its own
/// optional spec so a disabled delay can't accidentally carry a
/// stale seconds value.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureToggles {
    pub preview: bool,
    pub clipboard: bool,
    pub cursor: bool,
    /// Run the Smart-enhance pass (`domain::enhance`) before encoding.
    /// Mirrors `overlay::OverlayToggles::enhance`, including the serde
    /// default so an older payload still deserializes.
    #[serde(default)]
    pub enhance: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDelay {
    pub seconds: u32,
}

/// What the frontend sends when the user hits Capture.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    #[serde(rename = "type")]
    pub kind: CaptureKind,
    pub custom_mode: Option<CustomMode>,
    pub toggles: CaptureToggles,
    pub delay: Option<CaptureDelay>,
    pub effect: Option<String>,
    pub share: Option<String>,
    /// Optional save-directory override. `None` (or empty) = the live
    /// captures dir from settings. Set by the presets' "save to" output
    /// step (ADR 0004); the normal capture-window flow leaves it `None`.
    #[serde(default)]
    pub output_dir: Option<String>,
    /// Name of the preset running this capture, for the provenance
    /// record. `None` = an interactive capture.
    ///
    /// Which preset ran is the one provenance field the backend cannot
    /// observe: presets are executed by the frontend's `runPreset`
    /// orchestrator, which dispatches through the ordinary capture
    /// commands. So it travels the same route `output_dir` does — a
    /// request field the preset runner fills in — rather than being
    /// inferred at the save choke point like everything else in
    /// `domain::metadata`. Serde-defaulted, so an older payload (or the
    /// capture window, which never sets it) still parses.
    #[serde(default)]
    pub preset: Option<String>,
}

/// What the backend returns after a successful capture and what the
/// `clippity://capture/finished` event payload carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: CaptureKind,
    pub custom_mode: Option<CustomMode>,
    pub width: u32,
    pub height: u32,
    /// Absolute path to the on-disk PNG. Serialized as a JSON string.
    pub path: String,
    /// Whether the user asked to open this capture in the editor (the
    /// "Preview in Editor" toggle, mirrored from the capture request).
    /// Carried on `capture/finished` so one persistent listener can
    /// open the editor regardless of which window/mode produced the
    /// capture — instead of each dispatch path arming its own one-shot.
    pub preview: bool,
}

/// Outcome of a Clipboard custom-mode ingest. The system clipboard can
/// hold an image, plain text, or nothing, so the mode fans out three
/// ways (mirrors the legacy `ClipboardIngest`):
///
/// - `Image` — the clipboard held a bitmap; it was saved as a
///   file-backed capture (same pipeline as a screenshot) and the wrapped
///   [`CaptureResult`] points at the on-disk PNG.
/// - `Text` — the clipboard held text; it was persisted as an aux
///   library entry (no file), same as Grab-Text.
/// - `Empty` — nothing usable on the clipboard; the frontend turns this
///   into a friendly "copy something first" toast (no error).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ClipboardIngest {
    Image { capture: CaptureResult },
    Text { text: String },
    Empty,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_kind_serializes_kebab_case() {
        let json = serde_json::to_string(&CaptureKind::Fullscreen).unwrap();
        assert_eq!(json, "\"fullscreen\"");
        let parsed: CaptureKind = serde_json::from_str("\"fullscreen\"").unwrap();
        assert_eq!(parsed, CaptureKind::Fullscreen);
    }

    #[test]
    fn custom_mode_kebab_case_round_trip() {
        let json = serde_json::to_string(&CustomMode::ScrollingWindow).unwrap();
        assert_eq!(json, "\"scrolling-window\"");
        let parsed: CustomMode = serde_json::from_str("\"color-picker\"").unwrap();
        assert_eq!(parsed, CustomMode::ColorPicker);
    }

    #[test]
    fn request_camel_case_fields() {
        let req = CaptureRequest {
            kind: CaptureKind::Fullscreen,
            custom_mode: None,
            toggles: CaptureToggles {
                preview: true,
                clipboard: false,
                cursor: false,
                enhance: false,
            },
            delay: None,
            effect: None,
            share: None,
            output_dir: None,
            preset: None,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "fullscreen");
        assert!(v["customMode"].is_null());
        assert_eq!(v["toggles"]["preview"], true);
        assert!(v["delay"].is_null());
    }

    #[test]
    fn preset_name_rides_the_request_and_defaults_when_absent() {
        // The capture window sends no `preset` — that payload must still
        // parse, as "no preset ran".
        let interactive: CaptureRequest = serde_json::from_str(
            r#"{"type":"fullscreen","customMode":null,"toggles":{"preview":false,"clipboard":false,"cursor":false},"delay":null,"effect":null,"share":null}"#,
        )
        .unwrap();
        assert_eq!(interactive.preset, None);

        let from_preset: CaptureRequest = serde_json::from_str(
            r#"{"type":"fullscreen","customMode":null,"toggles":{"preview":false,"clipboard":false,"cursor":false},"delay":null,"effect":null,"share":null,"preset":"Docs shot"}"#,
        )
        .unwrap();
        assert_eq!(from_preset.preset.as_deref(), Some("Docs shot"));
    }

    #[test]
    fn request_round_trip_with_custom_mode() {
        let json = r#"{
            "type": "custom",
            "customMode": "palette-capture",
            "toggles": { "preview": true, "clipboard": false, "cursor": false },
            "delay": { "seconds": 5 },
            "effect": null,
            "share": null
        }"#;
        let req: CaptureRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.kind, CaptureKind::Custom);
        assert_eq!(req.custom_mode, Some(CustomMode::PaletteCapture));
        assert_eq!(req.delay.map(|d| d.seconds), Some(5));
    }

    #[test]
    fn result_serializes_with_camel_case_kind_alias() {
        let result = CaptureResult {
            id: "cap_1".into(),
            kind: CaptureKind::Fullscreen,
            custom_mode: None,
            width: 1920,
            height: 1080,
            path: "/tmp/x.png".into(),
            preview: true,
        };
        let v: serde_json::Value = serde_json::to_value(&result).unwrap();
        assert_eq!(v["type"], "fullscreen");
        assert_eq!(v["width"], 1920);
        assert!(v["customMode"].is_null());
        assert_eq!(v["preview"], true);
    }

    #[test]
    fn clipboard_ingest_tags_each_variant_kebab_case() {
        let img = ClipboardIngest::Image {
            capture: CaptureResult {
                id: "cap_1".into(),
                kind: CaptureKind::Custom,
                custom_mode: Some(CustomMode::Clipboard),
                width: 4,
                height: 3,
                path: "/tmp/x.png".into(),
                preview: false,
            },
        };
        let v = serde_json::to_value(&img).unwrap();
        assert_eq!(v["kind"], "image");
        assert_eq!(v["capture"]["customMode"], "clipboard");

        let text = ClipboardIngest::Text {
            text: "hello".into(),
        };
        assert_eq!(serde_json::to_value(&text).unwrap()["kind"], "text");

        assert_eq!(
            serde_json::to_value(ClipboardIngest::Empty).unwrap()["kind"],
            "empty"
        );
    }
}
