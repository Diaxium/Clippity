//! AI-model domain — the on-device model registry + status wire types.
//! **No I/O.** Download/install/delete live in `services::model_service`;
//! inference lives in `services::vision_service`.
//!
//! The registry is static data: every model Clippity knows how to fetch,
//! where from, and how to run it. Installing a model = downloading its
//! artifact(s) into `AppPaths.models` — a detector `<id>.onnx` and, for
//! typed models, a second `<id>.typer.onnx` crop classifier; the install
//! check is "every artifact exists with its expected size", so the domain
//! stays pure and the service layer owns the filesystem.
//!
//! Wire format: kebab-case enums, camelCase struct fields — matches the
//! rest of the IPC surface.

use serde::{Deserialize, Serialize};

/// What a model is *for*. Today only object detection (the Object
/// capture mode); reserved variants land with their owning features.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ModelTask {
    /// Detect objects / UI elements in a screenshot — powers the
    /// Object capture mode.
    ObjectDetection,
}

/// One downloadable file: fetched from `url`, verified by exact
/// `size_bytes`. Models are one or two of these (detector + optional
/// typer).
#[derive(Clone, Copy, Debug)]
pub struct ArtifactSpec {
    pub url: &'static str,
    pub size_bytes: u64,
    /// Byte sizes of older *published* releases of this exact artifact.
    /// A file on disk at one of these sizes (but not `size_bytes`) is a
    /// recognized previous version — it surfaces as an available update
    /// rather than a fresh download or a corrupt file. Empty for an
    /// artifact that has never been revised. Bump alongside `size_bytes`
    /// whenever you publish new bytes.
    pub prior_sizes: &'static [u64],
}

/// Optional second stage: a crop classifier that names each detected
/// box's element type (link / button / icon_button / …). Present only
/// for typed models; `None` leaves a model detection-only
/// (OmniParser, YOLO).
#[derive(Clone, Copy, Debug)]
pub struct TyperSpec {
    /// The `<id>.typer.onnx` artifact.
    pub artifact: ArtifactSpec,
    /// Square input edge the classifier expects (e.g. 224).
    pub input_size: u32,
    /// Box-padding fraction applied before cropping — MUST match the
    /// typer's training pad (e.g. 0.15).
    pub crop_pad: f32,
    /// Type labels in model output order (argmax index → label).
    pub labels: &'static [&'static str],
}

/// One artifact resolved against a model id — its on-disk file name plus
/// where to fetch it and how big it must be. Built by [`ModelSpec::artifacts`]
/// for a pinned registry install, or by the model service from a live
/// GitHub release for a self-update (hence `url` is owned, not `'static`).
#[derive(Clone, Debug)]
pub struct ModelArtifact {
    pub file_name: String,
    pub url: String,
    pub size_bytes: u64,
    /// Recognized older sizes for this artifact — see
    /// [`ArtifactSpec::prior_sizes`].
    pub prior_sizes: &'static [u64],
}

/// How to find a model's artifacts in a live GitHub release. Present only
/// for models hosted on GitHub Releases; `None` for HuggingFace
/// models, whose `resolve/main` URLs are a moving pointer with no
/// queryable "latest release" to compare against.
///
/// The matchers map a release's (possibly renamed) assets back onto this
/// model's artifact slots: an asset is the detector if its file name
/// contains `detector_match`, the typer if it contains `typer_match`. This
/// survives a detector asset being renamed across releases
/// (`model-det.onnx` → `model-det-v1.onnx`) without a registry edit.
#[derive(Clone, Copy, Debug)]
pub struct ReleaseSource {
    /// `owner/repo`, e.g. `octocat/model`. Drives the
    /// `api.github.com/repos/{repo}/releases/latest` lookup.
    pub repo: &'static str,
    /// Substring identifying the detector asset within a release's assets.
    pub detector_match: &'static str,
    /// Substring identifying the typer asset — `Some` for typed models,
    /// `None` for detection-only ones.
    pub typer_match: Option<&'static str>,
}

/// A registry entry: everything needed to download + run one model.
#[derive(Clone, Debug)]
pub struct ModelSpec {
    /// Stable id — also the on-disk file stem (`<id>.onnx`).
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub task: ModelTask,
    /// Human-facing version tag shown on the Models page (e.g. "1", "2").
    /// Bump whenever any artifact's bytes change so installed copies of
    /// the previous release surface as updatable.
    pub version: &'static str,
    /// Direct download URL for the detector `.onnx` artifact.
    pub url: &'static str,
    /// Expected detector size in bytes — drives download progress and
    /// the post-download integrity check (exact match required).
    pub size_bytes: u64,
    /// Byte sizes of older detector releases — see
    /// [`ArtifactSpec::prior_sizes`]. Empty when the detector has never
    /// been revised.
    pub detector_prior_sizes: &'static [u64],
    /// Square input edge the detector was exported for.
    pub input_size: u32,
    /// Detector class labels in model output order. One entry for
    /// single-class detectors (e.g. OmniParser).
    pub labels: &'static [&'static str],
    /// Optional crop classifier run after detection to type each box.
    pub typer: Option<TyperSpec>,
    /// Where to check for a newer published release at runtime. `Some` for
    /// GitHub-hosted models — the model service queries the live
    /// release, compares against what's on disk, and can self-update to it
    /// without an app rebuild. `None` leaves a model pinned to its
    /// compile-time `url`/`size_bytes` only.
    pub release: Option<ReleaseSource>,
    /// Rough quality/speed hint surfaced in the Models settings page.
    pub hint: &'static str,
}

impl ModelSpec {
    /// Total install size: detector + typer (when present). This is what
    /// the Models page shows and the download progress bar fills to.
    pub fn total_bytes(&self) -> u64 {
        self.size_bytes + self.typer.map_or(0, |t| t.artifact.size_bytes)
    }

    /// Every file this model installs, in download order — the detector
    /// `<id>.onnx` and, for typed models, the `<id>.typer.onnx`.
    pub fn artifacts(&self) -> Vec<ModelArtifact> {
        let mut out = vec![ModelArtifact {
            file_name: file_name(self.id),
            url: self.url.to_string(),
            size_bytes: self.size_bytes,
            prior_sizes: self.detector_prior_sizes,
        }];
        if let Some(t) = self.typer {
            out.push(ModelArtifact {
                file_name: typer_file_name(self.id),
                url: t.artifact.url.to_string(),
                size_bytes: t.artifact.size_bytes,
                prior_sizes: t.artifact.prior_sizes,
            });
        }
        out
    }
}

/// 80 COCO class labels in YOLO output order.
pub const COCO_LABELS: [&str; 80] = [
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
];

/// Single-class label set for class-agnostic UI detectors (e.g.
/// OmniParser — emits one "is interactive" class).
pub const UI_ELEMENT_LABELS: [&str; 1] = ["UI element"];

/// Default model id for the Object capture mode — referenced by
/// `domain::settings::ModelsSettings::default()`.
pub const DEFAULT_OBJECT_MODEL: &str = "ui-elements";

/// Every model Clippity can manage. Order = display order in the
/// Models settings page.
pub static REGISTRY: &[ModelSpec] = &[
    ModelSpec {
        id: "ui-elements",
        label: "UI Elements (OmniParser)",
        description:
            "Microsoft's OmniParser icon detector — finds buttons, icons, and interactive \
             elements on screen for capturing pieces of an app's UI.",
        task: ModelTask::ObjectDetection,
        version: "1",
        url: "https://huggingface.co/onnx-community/OmniParser-icon_detect/resolve/main/onnx/model.onnx",
        size_bytes: 12_136_163,
        detector_prior_sizes: &[],
        input_size: 640,
        labels: &UI_ELEMENT_LABELS,
        typer: None,
        // HuggingFace `resolve/main` is a moving pointer, not a release.
        release: None,
        hint: "12 MB · UI-focused · recommended",
    },
    ModelSpec {
        id: "yolov10n",
        label: "General Objects — Fast (YOLOv10-N)",
        description:
            "Lightweight general-purpose detector (80 everyday object classes: people, \
             screens, devices, …). Fastest option; good default on modest hardware.",
        task: ModelTask::ObjectDetection,
        version: "1",
        url: "https://huggingface.co/onnx-community/yolov10n/resolve/main/onnx/model.onnx",
        size_bytes: 9_386_116,
        detector_prior_sizes: &[],
        input_size: 640,
        labels: &COCO_LABELS,
        typer: None,
        release: None,
        hint: "9 MB · fastest",
    },
    ModelSpec {
        id: "yolov10s",
        label: "General Objects — Accurate (YOLOv10-S)",
        description:
            "Larger general-purpose detector with noticeably better accuracy on small \
             objects, at ~2-3× the inference cost of the fast variant.",
        task: ModelTask::ObjectDetection,
        version: "1",
        url: "https://huggingface.co/onnx-community/yolov10s/resolve/main/onnx/model.onnx",
        size_bytes: 29_187_904,
        detector_prior_sizes: &[],
        input_size: 640,
        labels: &COCO_LABELS,
        typer: None,
        release: None,
        hint: "29 MB · most accurate",
    },
];

/// Look a spec up by id. `None` for unknown ids (e.g. a stale
/// settings.json naming a model a newer registry dropped).
pub fn find(id: &str) -> Option<&'static ModelSpec> {
    REGISTRY.iter().find(|m| m.id == id)
}

/// On-disk file name for a model's detector artifact.
pub fn file_name(id: &str) -> String {
    format!("{id}.onnx")
}

/// On-disk file name for a model's optional typer artifact.
pub fn typer_file_name(id: &str) -> String {
    format!("{id}.typer.onnx")
}

/// Install/download phase, as shipped to the frontend.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "kebab-case", tag = "phase")]
pub enum ModelPhase {
    NotInstalled,
    Downloading {
        /// Bytes fetched so far.
        downloaded: u64,
        /// Total expected bytes (the spec size).
        total: u64,
    },
    Installed,
    /// A complete but *older* release is on disk — every artifact is a
    /// recognized size, but at least one is a previous version's bytes.
    /// The Models page offers "Update" (a re-download that swaps only the
    /// changed artifacts into place). Carries the registry's current
    /// `version` so the UI can name what's available.
    UpdateAvailable {
        version: String,
    },
    Error {
        message: String,
    },
}

/// One row of the Models settings page — a registry spec flattened to
/// wire shape + its live status.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub description: String,
    pub task: ModelTask,
    /// Registry version of this model — the latest Clippity can fetch.
    /// Always the *current* tag; `phase` says whether it's on disk yet.
    pub version: String,
    /// What's *actually on disk*, when known: a GitHub release tag (e.g.
    /// `onnx-v3`) recorded at install from the live release, or the
    /// registry `version` when the bytes match a pinned registry build.
    /// `None` when nothing is installed. Answers "which version do I have"
    /// directly, rather than leaving it inferred from `phase`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    /// Whether this model has a live release to check against (GitHub-hosted).
    /// Lets the UI show "checking…/latest/newer" only where a verdict can
    /// actually arrive, instead of for HuggingFace-pinned models too.
    pub checkable: bool,
    pub size_bytes: u64,
    pub hint: String,
    #[serde(flatten)]
    pub phase: ModelPhase,
}

impl ModelInfo {
    pub fn from_spec(spec: &ModelSpec, phase: ModelPhase) -> Self {
        Self {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
            description: spec.description.to_string(),
            task: spec.task,
            version: spec.version.to_string(),
            installed_version: None,
            checkable: spec.release.is_some(),
            // Detector + typer — what the user actually downloads.
            size_bytes: spec.total_bytes(),
            hint: spec.hint.to_string(),
            phase,
        }
    }

    /// Stamp the on-disk version (release tag or registry version). Called
    /// by the model service, which owns the filesystem the answer lives on.
    pub fn with_installed_version(mut self, version: Option<String>) -> Self {
        self.installed_version = version;
        self
    }
}

/// Payload of `clippity://models/progress` — throttled download ticks.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelProgress {
    pub id: String,
    pub downloaded: u64,
    pub total: u64,
}

/// Verdict of a live GitHub-release check for one model — returned by the
/// `models_check_updates` command, which the Models page fires on open.
/// Decoupled from [`ModelInfo`] (the offline registry status) because it
/// requires the network and is best-effort: a model whose check fails
/// simply has no `ReleaseCheck` in the returned list.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCheck {
    /// The model this verdict is about (registry id).
    pub id: String,
    /// Tag of GitHub's latest published (non-prerelease) release, e.g.
    /// `onnx-v3`.
    pub latest_tag: String,
    /// ISO-8601 publish timestamp of that release.
    pub published_at: String,
    /// Web URL of the release page (for a "view release" link).
    pub html_url: String,
    /// True when something is on disk for this model at all.
    pub installed: bool,
    /// True when the on-disk bytes match the latest release's assets — i.e.
    /// the installed model *is* the newest published one. Meaningless when
    /// `installed` is false.
    pub installed_is_latest: bool,
    /// True when the service resolved the release's detector (+ typer)
    /// assets and can fetch them — gates the live "Update" action. False if
    /// the release's assets didn't match this model's matchers.
    pub updatable: bool,
}

/// Readiness verdict for the Object capture mode — returned by the
/// `ensure_object_model` command so the capture window can branch
/// without re-implementing the policy.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ObjectModelReadiness {
    /// `ready` — model installed, overlay may open.
    /// `downloading` — fetch in flight (just started or already was).
    /// `missing` — not installed and auto-download is off.
    pub status: ReadinessStatus,
    /// The model the verdict is about (the configured object model,
    /// fallen back to the registry default when the setting is stale).
    pub model: ModelInfo,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReadinessStatus {
    Ready,
    Downloading,
    Missing,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic typed + GitHub-release model, built here so the typer
    /// and release-update assertions don't depend on any particular
    /// registered model. Not part of the shipping [`REGISTRY`].
    fn typed_release_spec() -> ModelSpec {
        ModelSpec {
            id: "typed-fixture",
            label: "Typed Fixture",
            description: "test-only typed model",
            task: ModelTask::ObjectDetection,
            version: "2",
            url: "https://github.com/octocat/model/releases/download/rel-v2/typed-fixture-det.onnx",
            size_bytes: 38_671_856,
            detector_prior_sizes: &[],
            input_size: 1280,
            labels: &UI_ELEMENT_LABELS,
            typer: Some(TyperSpec {
                artifact: ArtifactSpec {
                    url: "https://github.com/octocat/model/releases/download/rel-v2/typed-fixture-typer.onnx",
                    size_bytes: 6_138_446,
                    prior_sizes: &[6_134_346],
                },
                input_size: 224,
                crop_pad: 0.15,
                labels: &["button", "link", "icon"],
            }),
            release: Some(ReleaseSource {
                repo: "octocat/model",
                detector_match: "det",
                typer_match: Some("typer"),
            }),
            hint: "test",
        }
    }

    #[test]
    fn registry_ids_are_unique() {
        let mut ids: Vec<_> = REGISTRY.iter().map(|m| m.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), REGISTRY.len());
    }

    #[test]
    fn default_object_model_exists_in_registry() {
        assert!(find(DEFAULT_OBJECT_MODEL).is_some());
    }

    #[test]
    fn find_unknown_id_is_none() {
        assert!(find("not-a-model").is_none());
    }

    #[test]
    fn file_name_appends_onnx() {
        assert_eq!(file_name("yolov10n"), "yolov10n.onnx");
        assert_eq!(typer_file_name("some-model"), "some-model.typer.onnx");
    }

    #[test]
    fn coco_has_80_labels_and_ui_has_1() {
        assert_eq!(COCO_LABELS.len(), 80);
        assert_eq!(UI_ELEMENT_LABELS.len(), 1);
    }

    #[test]
    fn every_spec_has_positive_size_and_labels() {
        for spec in REGISTRY {
            assert!(spec.size_bytes > 0, "{}", spec.id);
            assert!(!spec.labels.is_empty(), "{}", spec.id);
            assert!(spec.input_size >= 320, "{}", spec.id);
            assert!(spec.url.starts_with("https://"), "{}", spec.id);
            // A typed model's typer artifact must be just as well-formed.
            if let Some(t) = spec.typer {
                assert!(t.artifact.size_bytes > 0, "{} typer", spec.id);
                assert!(t.artifact.url.starts_with("https://"), "{} typer", spec.id);
                assert!(!t.labels.is_empty(), "{} typer", spec.id);
                assert!(t.input_size >= 32, "{} typer", spec.id);
                assert!(t.crop_pad >= 0.0 && t.crop_pad < 1.0, "{} typer", spec.id);
            }
        }
    }

    #[test]
    fn typed_spec_install_size_is_detector_plus_typer() {
        let spec = typed_release_spec();
        let typer = spec.typer.expect("fixture has a typer");
        // Total install size = detector + typer (what the UI shows).
        assert_eq!(
            spec.total_bytes(),
            spec.size_bytes + typer.artifact.size_bytes
        );
        assert!(spec.total_bytes() > spec.size_bytes);
    }

    #[test]
    fn artifacts_lists_detector_then_typer() {
        let typed = typed_release_spec();
        let arts = typed.artifacts();
        assert_eq!(arts.len(), 2);
        assert_eq!(arts[0].file_name, "typed-fixture.onnx");
        assert_eq!(arts[0].size_bytes, typed.size_bytes);
        assert_eq!(arts[1].file_name, "typed-fixture.typer.onnx");
        assert_eq!(arts[1].size_bytes, typed.typer.unwrap().artifact.size_bytes);

        // A detection-only model lists exactly its detector.
        let omni = find("ui-elements").unwrap();
        let arts = omni.artifacts();
        assert_eq!(arts.len(), 1);
        assert_eq!(arts[0].file_name, "ui-elements.onnx");
        assert_eq!(omni.total_bytes(), omni.size_bytes);
    }

    #[test]
    fn model_phase_serializes_kebab_tagged() {
        let json = serde_json::to_string(&ModelPhase::Downloading {
            downloaded: 10,
            total: 100,
        })
        .unwrap();
        assert!(json.contains("\"phase\":\"downloading\""), "{json}");
        assert!(json.contains("\"downloaded\":10"), "{json}");

        let json = serde_json::to_string(&ModelPhase::NotInstalled).unwrap();
        assert!(json.contains("\"not-installed\""), "{json}");
    }

    #[test]
    fn update_available_phase_serializes_with_version() {
        let json = serde_json::to_string(&ModelPhase::UpdateAvailable {
            version: "2".into(),
        })
        .unwrap();
        assert!(json.contains("\"phase\":\"update-available\""), "{json}");
        assert!(json.contains("\"version\":\"2\""), "{json}");
    }

    #[test]
    fn typed_spec_records_prior_typer_size_for_update_detection() {
        let typed = typed_release_spec();
        let typer = typed.typer.unwrap();
        // The current bytes and the recognized previous release differ —
        // an on-disk copy at the prior size is an update, not a fresh
        // install or a corrupt file.
        assert!(!typer
            .artifact
            .prior_sizes
            .contains(&typer.artifact.size_bytes));
        assert!(typer.artifact.prior_sizes.contains(&6_134_346));
        // artifacts() carries the prior sizes through to the resolved typer.
        let arts = typed.artifacts();
        assert_eq!(arts[1].prior_sizes, typer.artifact.prior_sizes);
    }

    #[test]
    fn model_info_flattens_phase() {
        let spec = find("yolov10n").unwrap();
        let info = ModelInfo::from_spec(spec, ModelPhase::Installed);
        let v: serde_json::Value = serde_json::to_value(&info).unwrap();
        assert_eq!(v["id"], "yolov10n");
        assert_eq!(v["phase"], "installed");
        assert_eq!(v["sizeBytes"], 9_386_116);
        assert_eq!(v["task"], "object-detection");
    }

    #[test]
    fn readiness_serializes_kebab() {
        let spec = find(DEFAULT_OBJECT_MODEL).unwrap();
        let r = ObjectModelReadiness {
            status: ReadinessStatus::Downloading,
            model: ModelInfo::from_spec(spec, ModelPhase::NotInstalled),
        };
        let v: serde_json::Value = serde_json::to_value(&r).unwrap();
        assert_eq!(v["status"], "downloading");
        assert_eq!(v["model"]["id"], DEFAULT_OBJECT_MODEL);
    }
}
