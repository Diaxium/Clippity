//! Capture-preset domain types + pure rules.
//!
//! A preset is a saved capture configuration (`request`, reusing
//! `domain::capture::CaptureRequest`) plus post-capture output steps
//! (`output`). Persisted by `services::presets_service`; executed by the
//! frontend's `runPreset` orchestrator. No I/O here. See
//! [ADR 0004](../../docs/decisions/0004-capture-presets.md).
//!
//! Wire format: camelCase fields (`openEditor` / `saveDir`). The matching
//! frontend types live in `services/tauri/clients/presets.ts`.

use serde::{Deserialize, Serialize};

use crate::capture::CaptureRequest;

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

/// A saved, named capture + output workflow.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePreset {
    pub id: String,
    pub name: String,
    pub request: CaptureRequest,
    pub output: PresetOutput,
}

/// What the frontend sends to create a preset — everything but the `id`,
/// which the service mints.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInput {
    pub name: String,
    pub request: CaptureRequest,
    pub output: PresetOutput,
}

/// Pure: reject a blank name, returning the trimmed value so the service
/// stores a clean string. The only invariant a preset carries today —
/// the capture `kind` is already a closed enum and the toggles are
/// bools, so there's nothing else to validate.
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

    #[test]
    fn preset_round_trips_camel_case() {
        let p = CapturePreset {
            id: "preset_1_0".into(),
            name: "Region to clipboard".into(),
            request: sample_request(),
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
        assert_eq!(back.request.kind, CaptureKind::Region);
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
        assert_eq!(input.request.kind, CaptureKind::Fullscreen);
        // `output_dir` defaults when absent from the wire payload.
        assert!(input.request.output_dir.is_none());
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
