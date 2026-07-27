//! Library domain types — pure, no I/O.
//!
//! The library is the user-visible inventory of saved captures. MVP
//! handles **file-backed kinds only** (`image` / `video` / `gif`);
//! the three reserved variants (`Color` / `Palette` / `Text`) exist
//! so a future port can flip them armable without re-shaping the
//! wire contract — same pattern as `OverlayMode::Region` reserving
//! `Window` / `Object` / `Custom`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use clippity_infra::error::{AppError, AppResult};

/// What kind of capture this row represents. `image` / `video` /
/// `gif` are produced by the MVP filesystem scan; the other three
/// are reserved for future custom-mode ports.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum CaptureKind {
    Image,
    Video,
    Gif,
    // Reserved for future ports — the wire shape supports them so a
    // library catalog can mix file-backed and aux-only entries
    // later without re-shaping. MVP filesystem scan never produces
    // these.
    Color,
    Palette,
    Text,
}

/// A single sampled / quantized color stored in the aux catalog and
/// rendered as a swatch. `hex` is `#RRGGBB`; `r`/`g`/`b` is the same
/// color in 0-255 components (kept denormalized so the UI needn't parse
/// the hex). `proportion` is the swatch's share of its palette (0.0–1.0,
/// dominant first; the proportions across one palette sum to ~1).
///
/// `Eq` is intentionally not derived — `proportion` is an `f64`. The
/// catalog only ever compares colors for equality in tests, where
/// `PartialEq` suffices.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuxColor {
    pub hex: String,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    /// Palette-swatch share of the source region (0.0–1.0). `None` for a
    /// single sampled color (color-pick, where it has no meaning) and for
    /// palettes saved before proportions were tracked. `serde(default)`
    /// keeps those older `history.json` catalogs parseable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proportion: Option<f64>,
}

/// One library row. Carries the aux payload (`color` / `palette` /
/// `text`) for non-file entries (ADR 0006).
///
/// The `source_*` / `mode` / `width` / `height` / `monitor` / `preset`
/// block is **provenance**, read from the capture's `.meta` sidecar
/// during the scan
/// (`domain::metadata`). Every field there is optional and stays `None`
/// for captures saved before sidecars existed, for aux entries, and
/// whenever the sidecar is missing or unreadable — the row still
/// renders, just with less to say.
///
/// `tags` / `favorite` are **labels** — what the user says rather than
/// what was observed (`domain::labels`, ADR 0029). For a file-backed
/// capture they come from its `.labels` sidecar; for an aux entry, which
/// has no file to hang a sidecar off, they are stored on this row inside
/// the aux catalog. Collection membership is deliberately *not* here: a
/// collection is ordered, so it is its own document
/// (`domain::collections`) rather than a field repeated across rows.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMeta {
    /// Absolute path of the file. Doubles as the stable id across
    /// IPC calls. Brittleness: when a file moves to/from trash, the
    /// id changes — callers must re-list (or react to
    /// `clippity://library/updated`) to discover the new id.
    pub id: String,
    /// File stem (without extension). Used as the human-readable
    /// title on cards.
    pub title: String,
    pub kind: CaptureKind,
    pub created_at_ms: u128,
    pub size_bytes: u64,
    /// True when the entry is soft-deleted (a file under
    /// `<captures>/.trash/`, or an aux row with `trashed: true`).
    pub trashed: bool,
    /// Aux-only payload — `None` for file-backed entries. A `color`
    /// entry carries one swatch; a `palette` entry an ordered list
    /// (most-dominant first); `text` a grabbed string (grab-text port).
    /// `serde(default)` keeps old `history.json` catalogs parseable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<AuxColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette: Option<Vec<AuxColor>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,

    // ---- Provenance, from the `.meta` sidecar (see the type doc) ----
    /// Application that owned the dominant captured window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_app: Option<String>,
    /// Title of the dominant captured window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_window: Option<String>,
    /// Capture-mode label (`Region`, `Fullscreen`, `Edited`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Display the capture came from (`Display 1`, `Display 2`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor: Option<String>,
    /// Name of the capture preset that produced it, when one did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,

    // ---- Labels, from the `.labels` sidecar (see the type doc) ----
    /// Freeform user tags, normalised and sorted (`domain::labels`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Pinned by the user. Skipped when false, so an unfavorited row is
    /// the same on the wire as one that was never starred.
    #[serde(default, skip_serializing_if = "is_not_favorite")]
    pub favorite: bool,
}

fn is_not_favorite(favorite: &bool) -> bool {
    !*favorite
}

impl CaptureMeta {
    /// A row with nothing but the identity every entry has. Provenance
    /// and aux payloads are layered on by whichever producer knows them,
    /// so adding a future optional column doesn't mean editing every
    /// construction site.
    pub fn new(
        id: String,
        title: String,
        kind: CaptureKind,
        created_at_ms: u128,
        size_bytes: u64,
        trashed: bool,
    ) -> Self {
        Self {
            id,
            title,
            kind,
            created_at_ms,
            size_bytes,
            trashed,
            color: None,
            palette: None,
            text: None,
            source_app: None,
            source_window: None,
            mode: None,
            width: None,
            height: None,
            monitor: None,
            preset: None,
            tags: Vec::new(),
            favorite: false,
        }
    }
}

/// Pure: the sidecar file name for a capture — its full file name plus
/// `.json`, so `Shot.png` and `Shot.jpg` never collide the way sharing a
/// stem would.
///
/// One helper for every sidecar family (`.meta` provenance, `.scenes`
/// editable documents): they differ only in which hidden directory they
/// live under, and a capture's sidecars must agree on their file name or
/// moving one would orphan the others.
pub fn sidecar_file_name(capture_path: &str) -> String {
    let base = Path::new(capture_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("capture");
    format!("{base}.json")
}

/// Storage usage summary. `total_bytes` is the fixed display cap
/// (currently 10 GB — cross-platform free-disk-space via Tauri v2's
/// path API is unreliable; surface a generous cap so the UI can
/// render a progress bar).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub used_bytes: u64,
    pub total_bytes: u64,
}

/// Pure: classify a filename extension into a `CaptureKind`.
/// Anything not a known video / gif extension defaults to image —
/// matches the legacy precedent (an unknown extension on a file
/// in the captures dir is most likely a PNG saved by someone's
/// future custom-mode port).
pub fn kind_of(extension: Option<&str>) -> CaptureKind {
    match extension.map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("gif") => CaptureKind::Gif,
        Some("mp4") | Some("webm") | Some("mov") | Some("mkv") => CaptureKind::Video,
        _ => CaptureKind::Image,
    }
}

/// Pure: reject ids that escape the captures dir (or its `.trash`
/// subdir). Defense against malicious IPC payloads — the frontend
/// could send any string as an id. Returns the canonicalized path
/// on success.
///
/// Accepts both file-backed kinds (path starts with the captures
/// dir) and trashed entries (path starts with `<captures>/.trash`).
pub fn validate_id(id: &str, captures_root: &Path) -> AppResult<PathBuf> {
    let candidate = PathBuf::from(id);

    // Reject any id containing `..` segments outright — the only
    // legitimate ids are absolute paths produced by our own
    // filesystem scan, which never contain `..`.
    if candidate
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::Library("invalid id: parent traversal".into()));
    }

    // Compare lexically — `canonicalize` would fail for trash paths
    // that have just been renamed away, breaking the
    // delete-then-listen flow. Lexical comparison is sufficient
    // because the frontend only ever sends ids returned by our own
    // `list` command.
    let root_str = captures_root.to_string_lossy();
    let id_str = candidate.to_string_lossy();
    if !id_str.starts_with(root_str.as_ref()) {
        return Err(AppError::Library(
            "invalid id: outside captures root".into(),
        ));
    }

    Ok(candidate)
}

/// Pure: does this id name an aux-catalog entry (color / palette / text)
/// rather than a file? Aux entries use a synthetic `aux_<kind>_<ms>` id
/// so they live in the library without a real file. File ids are always
/// absolute paths under the captures root (`validate_id`), which never
/// start with `aux_` — so the prefix can't collide.
pub fn is_aux_id(id: &str) -> bool {
    id.starts_with("aux_")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- kind_of ----------

    #[test]
    fn kind_of_classifies_image_extensions() {
        assert_eq!(kind_of(Some("png")), CaptureKind::Image);
        assert_eq!(kind_of(Some("PNG")), CaptureKind::Image);
        assert_eq!(kind_of(Some("jpg")), CaptureKind::Image);
        assert_eq!(kind_of(Some("jpeg")), CaptureKind::Image);
        assert_eq!(kind_of(Some("webp")), CaptureKind::Image);
    }

    #[test]
    fn kind_of_classifies_video_extensions() {
        assert_eq!(kind_of(Some("mp4")), CaptureKind::Video);
        assert_eq!(kind_of(Some("WebM")), CaptureKind::Video);
        assert_eq!(kind_of(Some("mov")), CaptureKind::Video);
        assert_eq!(kind_of(Some("mkv")), CaptureKind::Video);
    }

    #[test]
    fn kind_of_classifies_gif_specifically() {
        assert_eq!(kind_of(Some("gif")), CaptureKind::Gif);
        assert_eq!(kind_of(Some("GIF")), CaptureKind::Gif);
    }

    #[test]
    fn kind_of_defaults_unknown_extension_to_image() {
        assert_eq!(kind_of(Some("xyz")), CaptureKind::Image);
        assert_eq!(kind_of(None), CaptureKind::Image);
        assert_eq!(kind_of(Some("")), CaptureKind::Image);
    }

    // ---------- validate_id ----------

    #[test]
    fn validate_id_accepts_path_under_captures_root() {
        let root = PathBuf::from("/tmp/clippity/captures");
        let id = "/tmp/clippity/captures/clippity-123.png";
        let resolved = validate_id(id, &root).expect("should validate");
        assert_eq!(resolved, PathBuf::from(id));
    }

    #[test]
    fn validate_id_accepts_path_in_trash_subdir() {
        let root = PathBuf::from("/tmp/clippity/captures");
        let id = "/tmp/clippity/captures/.trash/clippity-123.png";
        validate_id(id, &root).expect("trash should be allowed");
    }

    #[test]
    fn validate_id_rejects_parent_traversal() {
        let root = PathBuf::from("/tmp/clippity/captures");
        let bad = "/tmp/clippity/captures/../etc/passwd";
        let err = validate_id(bad, &root).unwrap_err();
        assert_eq!(err.code(), "library");
    }

    #[test]
    fn validate_id_rejects_path_outside_captures_root() {
        let root = PathBuf::from("/tmp/clippity/captures");
        let bad = "/etc/passwd";
        let err = validate_id(bad, &root).unwrap_err();
        assert_eq!(err.code(), "library");
    }

    // ---------- CaptureMeta serde ----------

    #[test]
    fn capture_meta_round_trips_camel_case() {
        let original = CaptureMeta::new(
            "/tmp/foo.png".into(),
            "foo".into(),
            CaptureKind::Image,
            1_700_000_000_000,
            12_345,
            false,
        );
        let s = serde_json::to_string(&original).unwrap();
        // camelCase rename — created_at_ms → createdAtMs, etc.
        assert!(s.contains(r#""createdAtMs":1700000000000"#));
        assert!(s.contains(r#""sizeBytes":12345"#));
        assert!(s.contains(r#""kind":"image""#));
        let back: CaptureMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(back.id, original.id);
        assert_eq!(back.kind, original.kind);
    }

    #[test]
    fn is_aux_id_distinguishes_synthetic_from_paths() {
        assert!(is_aux_id("aux_color_1700000000000"));
        assert!(is_aux_id("aux_palette_42"));
        assert!(!is_aux_id(r"C:\Users\me\Captures\clippity-1.png"));
        assert!(!is_aux_id("/home/me/captures/clippity-1.png"));
    }

    #[test]
    fn capture_meta_aux_fields_round_trip() {
        let color = AuxColor {
            hex: "#FF8800".into(),
            r: 255,
            g: 136,
            b: 0,
            proportion: None,
        };
        let entry = CaptureMeta {
            color: Some(color.clone()),
            ..CaptureMeta::new(
                "aux_color_1700000000000".into(),
                "#FF8800".into(),
                CaptureKind::Color,
                1_700_000_000_000,
                0,
                false,
            )
        };
        let s = serde_json::to_string(&entry).unwrap();
        assert!(s.contains(r#""kind":"color""#));
        assert!(s.contains(r##""hex":"#FF8800""##), "got {s}");
        // Absent aux fields are skipped, not serialized as null.
        assert!(!s.contains("palette"), "got {s}");
        assert!(!s.contains(r#""text""#), "got {s}");
        let back: CaptureMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(back.color, Some(color));
        assert_eq!(back.palette, None);
    }

    #[test]
    fn capture_meta_provenance_fields_round_trip() {
        let entry = CaptureMeta {
            source_app: Some("Chrome".into()),
            source_window: Some("GitHub - Chrome".into()),
            mode: Some("Region".into()),
            width: Some(1920),
            height: Some(1080),
            monitor: Some("Display 2".into()),
            preset: Some("Docs shot".into()),
            ..CaptureMeta::new(
                "/tmp/shot.png".into(),
                "shot".into(),
                CaptureKind::Image,
                1,
                2,
                false,
            )
        };
        let s = serde_json::to_string(&entry).unwrap();
        assert!(s.contains(r#""sourceApp":"Chrome""#), "got {s}");
        assert!(s.contains(r#""mode":"Region""#), "got {s}");
        assert!(s.contains(r#""monitor":"Display 2""#), "got {s}");
        assert!(s.contains(r#""preset":"Docs shot""#), "got {s}");
        let back: CaptureMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(back.source_window.as_deref(), Some("GitHub - Chrome"));
        assert_eq!((back.width, back.height), (Some(1920), Some(1080)));
        assert_eq!(back.monitor.as_deref(), Some("Display 2"));
        assert_eq!(back.preset.as_deref(), Some("Docs shot"));
    }

    #[test]
    fn capture_meta_label_fields_round_trip() {
        let entry = CaptureMeta {
            tags: vec!["bug".into(), "docs".into()],
            favorite: true,
            ..CaptureMeta::new("/t/s.png".into(), "s".into(), CaptureKind::Image, 1, 2, false)
        };
        let s = serde_json::to_string(&entry).unwrap();
        assert!(s.contains(r#""tags":["bug","docs"]"#), "got {s}");
        assert!(s.contains(r#""favorite":true"#), "got {s}");
        let back: CaptureMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(back.tags, vec!["bug".to_string(), "docs".to_string()]);
        assert!(back.favorite);
    }

    #[test]
    fn capture_meta_without_labels_omits_those_keys() {
        // An untagged capture must not ship `"tags":[]` + `"favorite":
        // false` on every row — the wire shape says "nothing to show".
        let entry = CaptureMeta::new("/a.png".into(), "a".into(), CaptureKind::Image, 1, 2, false);
        let s = serde_json::to_string(&entry).unwrap();
        assert!(!s.contains("tags"), "got {s}");
        assert!(!s.contains("favorite"), "got {s}");
        // ...and an old catalog entry with neither key still parses.
        let back: CaptureMeta = serde_json::from_str(&s).unwrap();
        assert!(back.tags.is_empty());
        assert!(!back.favorite);
    }

    #[test]
    fn capture_meta_without_provenance_omits_those_keys() {
        // A pre-sidecar capture must not serialize a wall of nulls the
        // frontend then has to guard on.
        let entry = CaptureMeta::new("/a.png".into(), "a".into(), CaptureKind::Image, 1, 2, false);
        let s = serde_json::to_string(&entry).unwrap();
        assert!(!s.contains("sourceApp"), "got {s}");
        assert!(!s.contains("mode"), "got {s}");
        assert!(!s.contains("width"), "got {s}");
        assert!(!s.contains("monitor"), "got {s}");
        assert!(!s.contains("preset"), "got {s}");
    }

    // ---------- sidecar_file_name ----------

    #[test]
    fn sidecar_file_name_appends_json_to_the_whole_file_name() {
        assert_eq!(sidecar_file_name("/tmp/captures/Shot.png"), "Shot.png.json");
        assert_eq!(sidecar_file_name(r"C:\caps\A B.png"), "A B.png.json");
    }

    #[test]
    fn sidecar_file_name_keeps_same_stem_different_extension_apart() {
        // The extension is part of the sidecar name on purpose: two
        // captures that differ only by format must not share metadata.
        assert_ne!(
            sidecar_file_name("/c/Shot.png"),
            sidecar_file_name("/c/Shot.jpg")
        );
    }

    #[test]
    fn sidecar_file_name_falls_back_when_there_is_no_file_component() {
        assert_eq!(sidecar_file_name(""), "capture.json");
    }

    #[test]
    fn storage_info_serializes_camel_case() {
        let info = StorageInfo {
            used_bytes: 100,
            total_bytes: 10_737_418_240,
        };
        let s = serde_json::to_string(&info).unwrap();
        assert!(s.contains(r#""usedBytes":100"#));
        assert!(s.contains(r#""totalBytes":10737418240"#));
    }
}
