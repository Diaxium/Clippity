//! Preset domain types + pure rules.
//!
//! A preset is a saved, named configuration — a still capture *or* a
//! recording — plus post-capture output steps (`output`). Persisted by
//! `services::presets_service`; executed by the frontend's `runPreset`
//! orchestrator. No I/O here. See
//! [ADR 0004](../../docs/decisions/0004-capture-presets.md).
//!
//! **Recordings are presets, not "scenes".** OBS calls a saved,
//! switchable capture configuration a scene; this codebase already had
//! the concept and called it a preset, and it only ever held a
//! `CaptureRequest` because the recorder was built afterwards (ADR
//! 0031). Introducing a parallel "scenes" surface would have meant two
//! managers, two editors and two run paths for one idea — so the preset
//! grew a second request type instead.
//!
//! Wire format: camelCase fields (`openEditor` / `saveDir`). The matching
//! frontend types live in `services/tauri/clients/presets.ts`.

use serde::{Deserialize, Serialize};

use crate::capture::CaptureRequest;
use crate::recorder::RecorderRequest;

/// Post-capture workflow steps. Copy-to-clipboard + include-cursor are
/// already modelled by `CaptureRequest.toggles`; these are the steps the
/// capture pipeline doesn't otherwise carry.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PresetOutput {
    /// Open the new capture in the editor once the capture finishes.
    pub open_editor: bool,
    /// Save-directory override for this preset. `None`/empty = the live
    /// captures dir from settings.
    pub save_dir: Option<String>,
}

/// What a preset does when it runs: take a still, or start a recording.
///
/// **Untagged, and that is a migration decision.** Presets already on
/// disk are bare `CaptureRequest` objects with no discriminant, and an
/// internally-tagged enum would refuse every one of them. Untagged reads
/// them unchanged.
///
/// It is safe here because the two shapes are **disjoint by required
/// field**, not merely different: a `CaptureRequest` must carry `type`
/// and `toggles`, a `RecorderRequest` must carry `target` and `format`,
/// and neither has a serde default. A payload can therefore satisfy at
/// most one variant, so the declaration order below carries no meaning.
/// `a_capture_payload_cannot_be_read_as_a_recording` and its twin pin
/// that down — if a future refactor gives either side a default for one
/// of those fields, the disjointness quietly disappears and those tests
/// are what will notice.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PresetRequest {
    Capture(CaptureRequest),
    // Boxed: `RecorderRequest` is much the larger of the two, and every
    // `CapturePreset` would otherwise carry its footprint.
    Record(Box<RecorderRequest>),
}

impl PresetRequest {
    pub fn is_record(&self) -> bool {
        matches!(self, PresetRequest::Record(_))
    }

    /// The still-capture request, or `None` for a recording preset.
    pub fn as_capture(&self) -> Option<&CaptureRequest> {
        match self {
            PresetRequest::Capture(c) => Some(c),
            PresetRequest::Record(_) => None,
        }
    }

    /// The recording request, or `None` for a capture preset.
    pub fn as_record(&self) -> Option<&RecorderRequest> {
        match self {
            PresetRequest::Record(r) => Some(r),
            PresetRequest::Capture(_) => None,
        }
    }
}

/// A saved, named capture-or-recording + output workflow.
///
/// Still called `CapturePreset` rather than renamed: the type crosses
/// the IPC boundary under this name, appears in the tray, the Home
/// launcher and the presets manager, and "capture" is the umbrella this
/// codebase already uses for both stills and recordings (see
/// `domain::library::CaptureKind`, which has had `video` and `gif` since
/// its first scan). Renaming would churn every call site to say the same
/// thing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePreset {
    pub id: String,
    pub name: String,
    pub request: PresetRequest,
    pub output: PresetOutput,
}

/// What the frontend sends to create a preset — everything but the `id`,
/// which the service mints.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInput {
    pub name: String,
    pub request: PresetRequest,
    pub output: PresetOutput,
}

/// Pure: reject a blank name, returning the trimmed value so the service
/// stores a clean string. Still the only invariant a preset carries:
/// both request shapes are closed enums and bools, and a recording
/// preset's loose numbers (frame rate, resolution, gains, bitrate) are
/// read-clamped by `domain::recorder::validate` when it actually runs —
/// so a preset saved under an older build with an out-of-range value
/// records rather than being refused at save time.
pub fn validate_name(name: &str) -> Result<String, &'static str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("preset name must not be empty");
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{CaptureKind, CaptureToggles};

    fn sample_request() -> CaptureRequest {
        CaptureRequest {
            kind: CaptureKind::Region,
            custom_mode: None,
            toggles: CaptureToggles {
                preview: false,
                clipboard: true,
                cursor: false,
                enhance: false,
            },
            delay: None,
            effect: None,
            share: None,
            output_dir: None,
            // A stored preset never pins its own name here: `runPreset`
            // stamps it at dispatch, so renaming a preset can't leave a
            // stale name behind in its saved request.
            preset: None,
        }
    }

    fn sample_recording() -> RecorderRequest {
        RecorderRequest {
            target: crate::recorder::RecorderTarget::Fullscreen,
            region: None,
            window_id: None,
            format: crate::recorder::RecorderFormat::Mp4,
            fps: Some(30),
            max_height: Some(1080),
            audio: Default::default(),
            encoding: Default::default(),
            sources: Vec::new(),
            toggles: Default::default(),
            output_dir: None,
            preset: None,
        }
    }

    #[test]
    fn preset_round_trips_camel_case() {
        let p = CapturePreset {
            id: "preset_1_0".into(),
            name: "Region to clipboard".into(),
            request: PresetRequest::Capture(sample_request()),
            output: PresetOutput {
                open_editor: true,
                save_dir: Some("/caps".into()),
            },
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"openEditor\":true"), "{json}");
        assert!(json.contains("\"saveDir\":\"/caps\""), "{json}");

        let back: CapturePreset = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "preset_1_0");
        assert_eq!(back.name, "Region to clipboard");
        assert!(back.output.open_editor);
        assert_eq!(back.output.save_dir.as_deref(), Some("/caps"));
        assert_eq!(
            back.request.as_capture().expect("a capture preset").kind,
            CaptureKind::Region
        );
    }

    // ---------- capture-or-recording ----------

    #[test]
    fn a_preset_saved_before_recordings_existed_still_loads() {
        // The whole reason `PresetRequest` is untagged: presets already
        // on disk are bare CaptureRequest objects with no discriminant,
        // and every one of them has to keep working.
        let json = r#"{
            "id": "preset_1_0",
            "name": "Old one",
            "request": {
                "type": "region",
                "customMode": null,
                "toggles": { "preview": false, "clipboard": true, "cursor": false },
                "delay": null,
                "effect": null,
                "share": null
            },
            "output": { "openEditor": false, "saveDir": null }
        }"#;
        let p: CapturePreset = serde_json::from_str(json).expect("legacy preset loads");
        assert!(!p.request.is_record());
        assert_eq!(
            p.request.as_capture().expect("a capture preset").kind,
            CaptureKind::Region
        );
    }

    #[test]
    fn a_recording_preset_round_trips() {
        let p = CapturePreset {
            id: "preset_2_0".into(),
            name: "Demo capture".into(),
            request: PresetRequest::Record(Box::new(sample_recording())),
            output: PresetOutput {
                open_editor: false,
                save_dir: None,
            },
        };
        let json = serde_json::to_string(&p).unwrap();
        // Untagged: the recording's own fields sit directly under
        // `request`, with no wrapper.
        assert!(json.contains("\"target\":\"fullscreen\""), "{json}");
        assert!(json.contains("\"format\":\"mp4\""), "{json}");

        let back: CapturePreset = serde_json::from_str(&json).unwrap();
        let rec = back.request.as_record().expect("a recording preset");
        assert_eq!(rec.format, crate::recorder::RecorderFormat::Mp4);
        assert_eq!(rec.max_height, Some(1080));
    }

    #[test]
    fn a_capture_payload_cannot_be_read_as_a_recording() {
        // Disjointness guard. `RecorderRequest` requires `target` and
        // `format`, neither of which a capture payload carries — if a
        // refactor ever defaults one of them, this catches it before a
        // user's still preset silently becomes a recording.
        let json = serde_json::to_string(&PresetRequest::Capture(sample_request())).unwrap();
        let back: PresetRequest = serde_json::from_str(&json).unwrap();
        assert!(!back.is_record(), "a capture matched the recording variant");
    }

    #[test]
    fn a_recording_payload_cannot_be_read_as_a_capture() {
        // The other half: `CaptureRequest` requires `type` and
        // `toggles`, which a recording payload lacks.
        let json =
            serde_json::to_string(&PresetRequest::Record(Box::new(sample_recording()))).unwrap();
        let back: PresetRequest = serde_json::from_str(&json).unwrap();
        assert!(back.is_record(), "a recording matched the capture variant");
    }

    #[test]
    fn a_recording_preset_input_parses_from_the_wire() {
        let json = r#"{
            "name": "Screen demo",
            "request": { "target": "fullscreen", "format": "gif", "fps": 15 },
            "output": { "openEditor": false, "saveDir": null }
        }"#;
        let input: PresetInput = serde_json::from_str(json).unwrap();
        let rec = input.request.as_record().expect("a recording preset");
        assert_eq!(rec.format, crate::recorder::RecorderFormat::Gif);
        assert_eq!(rec.fps, Some(15));
        // Everything else serde-defaults, so the frontend can save a
        // recording preset with three fields.
        assert!(!rec.audio.any());
    }

    #[test]
    fn input_round_trips_without_id() {
        let json = r#"{
            "name": "Fullscreen",
            "request": {
                "type": "fullscreen",
                "customMode": null,
                "toggles": { "preview": false, "clipboard": true, "cursor": false },
                "delay": null,
                "effect": null,
                "share": null
            },
            "output": { "openEditor": false, "saveDir": null }
        }"#;
        let input: PresetInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.name, "Fullscreen");
        let capture = input.request.as_capture().expect("a capture preset");
        assert_eq!(capture.kind, CaptureKind::Fullscreen);
        // `output_dir` defaults when absent from the wire payload.
        assert!(capture.output_dir.is_none());
    }

    #[test]
    fn validate_name_trims() {
        assert_eq!(validate_name("  Shot  ").unwrap(), "Shot");
    }

    #[test]
    fn validate_name_rejects_blank() {
        assert!(validate_name("   ").is_err());
        assert!(validate_name("").is_err());
    }
}
