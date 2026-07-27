//! Editor domain types — pure, no I/O.
//!
//! The editor opens an existing capture (file-backed), lets the user
//! draw annotations + crop, and saves a flattened image as a *new*
//! capture in the same directory. Annotation geometry lives in the
//! frontend (Canvas2D + SVG); the backend only sees the final
//! pixel-baked data URI on save.
//!
//! **MVP scope (Tier 2)**: open an image from the captures dir,
//! return its bytes as a base64 data URI; accept a flattened image
//! data URI on save and persist it. No per-annotation Rust types —
//! those live entirely in the frontend feature folder.
//!
//! **Formats.** The frontend's Canvas2D `toDataURL` can encode PNG,
//! JPEG and WebP, so the save path is format-driven rather than
//! PNG-only: [`parse_image_data_uri`] reads the declared MIME and the
//! resulting [`ImageFormat`] picks the on-disk extension. The backend
//! never transcodes — it persists exactly the bytes the canvas
//! produced.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::library;

/// What the frontend gets back when it opens a capture in the editor.
/// `data_uri` is a `data:image/png;base64,...` string consumable by
/// `<img>` and Canvas2D without an extra fetch.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditorImage {
    /// The id that was loaded (= absolute path on disk).
    pub id: String,
    pub data_uri: String,
    pub width: u32,
    pub height: u32,
    /// The saved editable scene (a JSON document) if a sidecar exists for
    /// this capture; `None` for a capture that has only ever been a flat
    /// image. When present the frontend restores the editable scene instead
    /// of re-seeding from the flattened pixels.
    #[serde(default)]
    pub scene: Option<String>,
}

/// Sidecar filename for a capture's editable scene: `<filename>.json`
/// (e.g. `Shot.png` → `Shot.png.json`). The sidecar lives in the hidden
/// `.scenes` subdir of the captures directory so it never appears in the
/// library scan (which skips dot-prefixed entries). Pure — no I/O.
///
/// Delegates to [`library::sidecar_file_name`], which every sidecar
/// family shares: the `.meta` provenance record must resolve to the
/// *same* name, or `services::sidecar` would move one and orphan the
/// other when a capture is trashed.
pub fn scene_file_name(capture_path: &str) -> String {
    library::sidecar_file_name(capture_path)
}

/// What the frontend sends when it saves an edited capture. The
/// backend treats the `data_uri` as opaque encoded bytes — frontend has
/// already flattened annotations + effects via Canvas2D.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditorSaveRequest {
    pub data_uri: String,
}

/// An image encoding the editor can save. Deliberately narrow: exactly
/// the three formats a browser `canvas.toDataURL` is guaranteed to
/// produce. Anything else in a data URI is rejected rather than written
/// under a misleading extension.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Png,
    Jpeg,
    Webp,
}

impl ImageFormat {
    /// On-disk extension, without the dot. JPEG saves as `.jpg` (the
    /// conventional extension) even though its MIME subtype is `jpeg`.
    pub fn extension(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpg",
            ImageFormat::Webp => "webp",
        }
    }

    /// Canonical MIME type — what a data URI for this format declares.
    pub fn mime(self) -> &'static str {
        match self {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::Webp => "image/webp",
        }
    }

    /// Parse a MIME *subtype* (the part after `image/`). Accepts `jpg`
    /// alongside `jpeg` because some encoders emit it.
    pub fn from_mime_subtype(subtype: &str) -> Option<Self> {
        match subtype.to_ascii_lowercase().as_str() {
            "png" => Some(ImageFormat::Png),
            "jpeg" | "jpg" => Some(ImageFormat::Jpeg),
            "webp" => Some(ImageFormat::Webp),
            _ => None,
        }
    }
}

/// A parsed `data:image/<subtype>;base64,<payload>` URI. Borrows the
/// payload from the input so callers decode without an extra copy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImagePayload<'a> {
    pub format: ImageFormat,
    pub base64: &'a str,
}

/// Pure: split a base64 image data URI into its format + payload.
/// Returns `None` when the URI is malformed, not base64-encoded, or
/// declares a format the editor does not save.
pub fn parse_image_data_uri(data_uri: &str) -> Option<ImagePayload<'_>> {
    let rest = data_uri.strip_prefix("data:image/")?;
    let (subtype, payload) = rest.split_once(";base64,")?;
    let format = ImageFormat::from_mime_subtype(subtype)?;
    Some(ImagePayload {
        format,
        base64: payload,
    })
}

/// Pure: the MIME type to declare when handing a capture file back to
/// the frontend as a data URI. Covers the formats the library can hold,
/// not just the ones the editor writes — a `.jpg` capture opened in the
/// editor must not be announced as PNG, or the webview may refuse to
/// decode it. Unknown extensions fall back to PNG, matching
/// `library::kind_of`'s "unknown means image" precedent.
pub fn mime_for_path(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        _ => "image/png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_splits_format_and_payload() {
        let p = parse_image_data_uri("data:image/png;base64,iVBORw0K").unwrap();
        assert_eq!(p.format, ImageFormat::Png);
        assert_eq!(p.base64, "iVBORw0K");
    }

    #[test]
    fn parse_accepts_every_savable_format() {
        let cases = [
            ("data:image/jpeg;base64,abc", ImageFormat::Jpeg),
            // Some encoders emit the `jpg` subtype.
            ("data:image/jpg;base64,abc", ImageFormat::Jpeg),
            ("data:image/webp;base64,abc", ImageFormat::Webp),
            // Subtype casing is not significant.
            ("data:image/WEBP;base64,abc", ImageFormat::Webp),
        ];
        for (uri, expected) in cases {
            let p = parse_image_data_uri(uri).unwrap_or_else(|| panic!("parse {uri}"));
            assert_eq!(p.format, expected, "for {uri}");
            assert_eq!(p.base64, "abc");
        }
    }

    #[test]
    fn parse_rejects_unsupported_or_malformed_uris() {
        // A real image format, but not one the editor writes.
        assert!(parse_image_data_uri("data:image/gif;base64,abc").is_none());
        assert!(parse_image_data_uri("data:image/svg+xml;base64,abc").is_none());
        // Not base64 / not a data URI at all.
        assert!(parse_image_data_uri("data:image/png,raw-bytes").is_none());
        assert!(parse_image_data_uri("data:text/plain;base64,abc").is_none());
        assert!(parse_image_data_uri("not a data uri").is_none());
        assert!(parse_image_data_uri("").is_none());
    }

    #[test]
    fn format_extension_and_mime_agree() {
        assert_eq!(ImageFormat::Png.extension(), "png");
        assert_eq!(ImageFormat::Png.mime(), "image/png");
        // JPEG's conventional extension differs from its MIME subtype.
        assert_eq!(ImageFormat::Jpeg.extension(), "jpg");
        assert_eq!(ImageFormat::Jpeg.mime(), "image/jpeg");
        assert_eq!(ImageFormat::Webp.extension(), "webp");
        assert_eq!(ImageFormat::Webp.mime(), "image/webp");
        // Every format's own MIME subtype round-trips back to it.
        for f in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::Webp] {
            let subtype = f.mime().strip_prefix("image/").unwrap();
            assert_eq!(ImageFormat::from_mime_subtype(subtype), Some(f));
        }
    }

    #[test]
    fn mime_for_path_reads_the_extension() {
        assert_eq!(mime_for_path("/caps/a.png"), "image/png");
        assert_eq!(mime_for_path("/caps/a.jpg"), "image/jpeg");
        assert_eq!(mime_for_path("/caps/a.JPEG"), "image/jpeg");
        assert_eq!(mime_for_path(r"C:\caps\a.webp"), "image/webp");
        assert_eq!(mime_for_path("/caps/a.gif"), "image/gif");
        // Unknown / missing extension falls back to PNG.
        assert_eq!(mime_for_path("/caps/a.tiff"), "image/png");
        assert_eq!(mime_for_path("/caps/noext"), "image/png");
    }

    #[test]
    fn editor_image_round_trips_camel_case() {
        let original = EditorImage {
            id: "/tmp/captures/foo.png".into(),
            data_uri: "data:image/png;base64,abc".into(),
            width: 1920,
            height: 1080,
            scene: None,
        };
        let s = serde_json::to_string(&original).unwrap();
        assert!(s.contains(r#""dataUri":"data:image/png;base64,abc""#));
        assert!(s.contains(r#""width":1920"#));
        // A null scene survives the round-trip (frontend treats it as "no
        // saved scene → seed from the flat image").
        assert!(s.contains(r#""scene":null"#));
        let back: EditorImage = serde_json::from_str(&s).unwrap();
        assert_eq!(back.id, original.id);
        assert_eq!(back.width, 1920);
        assert!(back.scene.is_none());
    }

    #[test]
    fn scene_file_name_appends_json_to_the_basename() {
        assert_eq!(scene_file_name("/tmp/captures/Shot.png"), "Shot.png.json");
        assert_eq!(scene_file_name(r"C:\caps\A B.png"), "A B.png.json");
        // A path with no file component still yields a usable name —
        // the fallback is `library::sidecar_file_name`'s, shared with
        // the `.meta` record so both families agree.
        assert_eq!(scene_file_name(""), "capture.json");
    }
}
