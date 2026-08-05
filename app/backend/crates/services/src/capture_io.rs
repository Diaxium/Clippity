//! Post-capture I/O primitives shared by the fullscreen capture
//! pipeline (`capture_service`) and the region-overlay pipeline
//! (`overlay_service`).
//!
//! Each helper is service-agnostic — it knows how to persist encoded
//! image bytes to disk, push image bytes to the system clipboard, and
//! mint a per-capture identifier, but nothing about the caller's domain.
//! Promoted from byte-identical inline copies that lived in both
//! services during the overlay port's Phase 1; collapsed here once a
//! second consumer existed (per `FEATURE_RULES.md` — promote on the
//! second consumer, never on the first).

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use image::{DynamicImage, ImageFormat, RgbaImage};

use crate::sidecar;
use clippity_domain::metadata::{self, CaptureSource};
use clippity_domain::naming::{self, LocalTime};
use clippity_infra::error::{AppError, AppResult};

/// Render a recognisable file name from the user's template + the
/// capture's `source`, then persist `bytes` under it as a PNG. The entry
/// point every *capture* pipeline (fullscreen, overlay, scroll) uses so
/// the naming scheme stays consistent across modes. The editor's export
/// path, which can also write JPEG/WebP, goes through
/// [`save_capture_image`] — this is the PNG-shaped shorthand for it.
///
/// `template` is the raw `general.name_template` (blank = the built-in
/// default). Returns the absolute path actually written (which may carry
/// a ` (2)` collision suffix — see [`save_image`]).
pub fn save_capture_png(
    dir: &Path,
    bytes: &[u8],
    template: &str,
    source: &CaptureSource,
) -> AppResult<PathBuf> {
    save_capture_image(dir, bytes, template, source, "png")
}

/// [`save_capture_png`] with a caller-chosen extension. `bytes` must
/// already be encoded in that format — nothing here transcodes; the
/// extension only names what the caller produced.
///
/// **This is where a capture's provenance record is written**, not in
/// any individual pipeline. Naming and metadata read the same
/// [`CaptureSource`] and the same clock instant, so a capture's file
/// name and its `.meta` sidecar can never describe different origins;
/// and every mode — including ones added later — records provenance by
/// construction rather than by remembering to. Same reasoning that put
/// smart-enhance and the PNG encode in `overlay_service::persist_and_emit`.
///
/// A sidecar that cannot be written is logged and swallowed: the
/// capture is the product, the record is description, and a read-only
/// output folder must not cost the user their screenshot.
pub fn save_capture_image(
    dir: &Path,
    bytes: &[u8],
    template: &str,
    source: &CaptureSource,
    ext: &str,
) -> AppResult<PathBuf> {
    let stem = naming::render(template, source, local_now());
    let path = save_image(dir, bytes, &stem, ext)?;

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let record = metadata::build(source, &file_name, now_ms());
    if let Err(e) = sidecar::write_metadata(&path, &record) {
        tracing::warn!("capture metadata sidecar not written: {e:?}");
    }

    Ok(path)
}

/// Move an already-written file into the captures directory under the
/// user's naming template, and record its provenance.
///
/// The recorder's counterpart to [`save_capture_image`]. A recording is
/// streamed to disk over minutes and can be gigabytes, so it is never
/// held in memory as `bytes` — it is written to a working file and
/// promoted here once the session commits. The provenance sidecar is
/// still written at this one choke point, so a recording describes
/// itself exactly the way a screenshot does.
///
/// `temp` must already live in `dir` (the caller writes it there), so
/// the promotion is a rename within one volume — atomic, and free
/// regardless of the recording's size.
pub fn promote_capture_file(
    temp: &Path,
    dir: &Path,
    template: &str,
    source: &CaptureSource,
    ext: &str,
) -> AppResult<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let stem = naming::render(template, source, local_now());
    let stem = if stem.trim().is_empty() {
        "Clippity"
    } else {
        &stem
    };
    let path = unique_image_path(dir, stem, ext);
    std::fs::rename(temp, &path)?;

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let record = metadata::build(source, &file_name, now_ms());
    if let Err(e) = sidecar::write_metadata(&path, &record) {
        tracing::warn!("recording metadata sidecar not written: {e:?}");
    }
    Ok(path)
}

/// Persist `bytes` to `dir/{stem}.png`. Thin shorthand over
/// [`save_image`] for the PNG-only capture pipelines.
pub fn save_png(dir: &Path, bytes: &[u8], stem: &str) -> AppResult<PathBuf> {
    save_image(dir, bytes, stem, "png")
}

/// Persist `bytes` to `dir/{stem}.{ext}`, creating `dir` if missing and
/// suffixing ` (2)`, ` (3)`, … when a file of that name already exists so
/// two captures that render to the same stem never clobber each other.
/// `stem` is expected to be pre-sanitised (`naming::render`); a blank one
/// falls back to a safe constant.
pub fn save_image(dir: &Path, bytes: &[u8], stem: &str, ext: &str) -> AppResult<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let stem = if stem.trim().is_empty() {
        "Clippity"
    } else {
        stem
    };
    let path = unique_image_path(dir, stem, ext);
    std::fs::write(&path, bytes)?;
    Ok(path)
}

/// First non-existent `dir/{stem}.{ext}` / `dir/{stem} (n).{ext}`. Bounded
/// so a wedged directory can't spin forever; the pathological fallback pins
/// an epoch suffix that is effectively collision-free.
fn unique_image_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    for n in 2..=9_999 {
        let candidate = dir.join(format!("{stem} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    dir.join(format!("{stem} {ts}.{ext}"))
}

/// Milliseconds since the Unix epoch — the metadata record's
/// `captured_at_ms`. Deliberately not derived from [`local_now`]: this
/// is an absolute instant, while that is a zone-adjusted wall clock for
/// display in a file name.
fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Current **local** wall-clock time, broken down for the namer. On
/// Windows this is `GetLocalTime` (already zone-adjusted, no crate
/// needed); elsewhere it falls back to UTC derived from the epoch (the
/// app only ships on Windows, so the fallback just keeps cross-platform
/// builds/tests compiling).
#[cfg(target_os = "windows")]
pub fn local_now() -> LocalTime {
    use windows::Win32::System::SystemInformation::GetLocalTime;

    // SAFETY: GetLocalTime has no preconditions and returns a SYSTEMTIME by value.
    let st = unsafe { GetLocalTime() };
    LocalTime {
        year: st.wYear as i32,
        month: st.wMonth as u32,
        day: st.wDay as u32,
        hour: st.wHour as u32,
        minute: st.wMinute as u32,
        second: st.wSecond as u32,
    }
}

#[cfg(not(target_os = "windows"))]
pub fn local_now() -> LocalTime {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    naming::civil_from_unix(secs)
}

/// Push an already-decoded RGBA image straight to the system clipboard,
/// skipping the PNG round-trip. The fullscreen capture pipeline still
/// holds the `RgbaImage` in memory at the clipboard step, so it uses
/// this instead of `copy_png_to_clipboard` — which would re-decode the
/// PNG it just encoded (a full multi-megapixel decode per capture).
/// Errors surface as `String` for the same log-and-continue ergonomics.
pub fn copy_rgba_to_clipboard(img: &image::RgbaImage) -> Result<(), String> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_image(arboard::ImageData {
        width: w,
        height: h,
        bytes: std::borrow::Cow::Borrowed(img.as_raw().as_slice()),
    })
    .map_err(|e| e.to_string())
}

/// Decode the PNG bytes and push the image to the system clipboard
/// via `arboard`. Returns the underlying error as `String` so
/// callers can log + continue without leaking the `arboard` types.
/// Prefer `copy_rgba_to_clipboard` when the caller already has the
/// decoded image (the fullscreen path does); this byte-oriented variant
/// is for callers that only hold encoded PNG bytes (the overlay path).
pub fn copy_png_to_clipboard(bytes: &[u8]) -> Result<(), String> {
    let img = image::load_from_memory_with_format(bytes, ImageFormat::Png)
        .map_err(|e| format!("png decode: {e}"))?;
    let rgba = img.into_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    let buf = rgba.into_raw();
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_image(arboard::ImageData {
        width: w,
        height: h,
        bytes: buf.into(),
    })
    .map_err(|e| e.to_string())
}

/// Push plain text to the system clipboard via `arboard`. Used by the
/// Color-Picker overlay mode (copies the sampled `#RRGGBB`). Returns the
/// error as `String` so callers can log + continue without leaking the
/// `arboard` types — same log-and-continue ergonomics as the image
/// variants above.
pub fn copy_text_to_clipboard(text: &str) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text.to_owned()).map_err(|e| e.to_string())
}

/// Pick the save directory: a non-empty (trimmed) override, else the
/// `fallback` (the live captures dir). Shared by the fullscreen capture
/// pipeline and the overlay-region pipeline so a preset's "save to"
/// behaves identically in both. See ADR 0004.
pub fn resolve_save_dir(override_dir: Option<&str>, fallback: PathBuf) -> PathBuf {
    override_dir
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or(fallback)
}

/// Per-capture identifier — millisecond epoch with a `cap_` prefix.
/// Stable enough for in-session correlation; the on-disk PNG path
/// carries cross-process uniqueness.
pub fn next_id() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("cap_{ts}")
}

/// What the system clipboard currently holds, decoded for ingest.
/// Image wins over text — `arboard` (like the OS) prefers the bitmap
/// channel when both are present. Not serialized; the command maps it to
/// the wire `ClipboardIngest`.
pub enum ClipboardContent {
    Image(RgbaImage),
    Text(String),
    Empty,
}

/// Read the system clipboard for the Clipboard custom mode. Returns
/// [`ClipboardContent::Empty`] when the clipboard holds neither an image
/// nor non-blank text — that's an expected outcome, not an error. A
/// genuine access failure (clipboard locked/unavailable, or a bitmap
/// whose declared dimensions don't match its buffer) is an
/// `AppError::Capture`.
pub fn read_clipboard() -> AppResult<ClipboardContent> {
    let mut cb =
        arboard::Clipboard::new().map_err(|e| AppError::Capture(format!("clipboard open: {e}")))?;
    if let Ok(img) = cb.get_image() {
        let (w, h) = (img.width as u32, img.height as u32);
        let rgba = RgbaImage::from_raw(w, h, img.bytes.into_owned())
            .ok_or_else(|| AppError::Capture("clipboard image buffer size mismatch".into()))?;
        return Ok(ClipboardContent::Image(rgba));
    }
    match cb.get_text() {
        Ok(text) => Ok(normalize_clipboard_text(&text)
            .map(ClipboardContent::Text)
            .unwrap_or(ClipboardContent::Empty)),
        Err(_) => Ok(ClipboardContent::Empty),
    }
}

/// Pure: trim clipboard text and treat a blank result as "nothing to
/// ingest". Returns the trimmed text, or `None` when it's empty after
/// trimming. Trimming only outer whitespace keeps internal indentation
/// (e.g. copied code) intact.
fn normalize_clipboard_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// Downscale `img` so its longest edge is at most `max_edge`, encode it
/// as PNG, and return a `data:image/png;base64,…` URI for a toast
/// preview thumbnail. Returns an empty string if encoding fails (the
/// toast simply shows no preview). Shared by the Palette-Capture and
/// Clipboard previews — promoted here on the second consumer.
pub fn thumbnail_data_uri(img: &RgbaImage, max_edge: u32) -> String {
    let (w, h) = (img.width(), img.height());
    let longest = w.max(h);
    let small = if longest > max_edge {
        let scale = max_edge as f64 / longest as f64;
        let nw = ((w as f64 * scale).round() as u32).max(1);
        let nh = ((h as f64 * scale).round() as u32).max(1);
        image::imageops::thumbnail(img, nw, nh)
    } else {
        img.clone()
    };
    let mut png = Vec::new();
    if DynamicImage::ImageRgba8(small)
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .is_err()
    {
        return String::new();
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    format!("data:image/png;base64,{b64}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_save_dir_prefers_nonempty_override() {
        let fallback = PathBuf::from("/fallback");
        assert_eq!(
            resolve_save_dir(Some("/custom"), fallback.clone()),
            PathBuf::from("/custom")
        );
        // Whitespace-only override falls back.
        assert_eq!(resolve_save_dir(Some("   "), fallback.clone()), fallback);
        // Absent override falls back.
        assert_eq!(resolve_save_dir(None, fallback.clone()), fallback);
    }

    #[test]
    fn next_id_has_cap_prefix() {
        let id = next_id();
        assert!(
            id.starts_with("cap_"),
            "expected cap_-prefixed id, got {id}"
        );
        // The suffix is millis-since-epoch — at minimum a few digits.
        assert!(id.len() > "cap_".len() + 4);
    }

    #[test]
    fn save_png_writes_to_stem_named_file() {
        let dir = std::env::temp_dir().join(format!("clippity-capture-io-{}", next_id()));
        // Arbitrary bytes — the helper does not validate PNG content,
        // it just persists what it was given.
        let payload: &[u8] = b"\x89PNG\r\n\x1a\n-not-actually-a-png";
        let path = save_png(&dir, payload, "My Capture").expect("save_png ok");

        let read_back = std::fs::read(&path).expect("read back from disk");
        assert_eq!(read_back, payload);

        let fname = path.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(fname, "My Capture.png");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_png_suffixes_on_collision() {
        let dir = std::env::temp_dir().join(format!("clippity-capture-io-col-{}", next_id()));
        let a = save_png(&dir, b"a", "Shot").expect("first ok");
        let b = save_png(&dir, b"b", "Shot").expect("second ok");
        let c = save_png(&dir, b"c", "Shot").expect("third ok");

        assert_eq!(a.file_name().unwrap().to_string_lossy(), "Shot.png");
        assert_eq!(b.file_name().unwrap().to_string_lossy(), "Shot (2).png");
        assert_eq!(c.file_name().unwrap().to_string_lossy(), "Shot (3).png");
        // Each kept its own bytes — no clobber.
        assert_eq!(std::fs::read(&a).unwrap(), b"a");
        assert_eq!(std::fs::read(&b).unwrap(), b"b");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_png_blank_stem_falls_back() {
        let dir = std::env::temp_dir().join(format!("clippity-capture-io-blank-{}", next_id()));
        let path = save_png(&dir, b"x", "   ").expect("save ok");
        assert_eq!(path.file_name().unwrap().to_string_lossy(), "Clippity.png");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_image_honours_the_requested_extension() {
        let dir = std::env::temp_dir().join(format!("clippity-capture-io-ext-{}", next_id()));
        let jpg = save_image(&dir, b"j", "Shot", "jpg").expect("jpg ok");
        let webp = save_image(&dir, b"w", "Shot", "webp").expect("webp ok");

        assert_eq!(jpg.file_name().unwrap().to_string_lossy(), "Shot.jpg");
        // A different extension is a different file — no collision suffix.
        assert_eq!(webp.file_name().unwrap().to_string_lossy(), "Shot.webp");
        assert_eq!(std::fs::read(&jpg).unwrap(), b"j");
        assert_eq!(std::fs::read(&webp).unwrap(), b"w");

        // Collisions still suffix, keeping the extension last.
        let second = save_image(&dir, b"j2", "Shot", "jpg").expect("second jpg ok");
        assert_eq!(
            second.file_name().unwrap().to_string_lossy(),
            "Shot (2).jpg"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_capture_image_stamps_extension_onto_the_template() {
        let dir = std::env::temp_dir().join(format!("clippity-capture-io-tpl3-{}", next_id()));
        let path = save_capture_image(&dir, b"x", "", &CaptureSource::from_mode("Edited"), "webp")
            .expect("save ok");
        let fname = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(fname.starts_with("Edited - "), "got {fname}");
        assert!(fname.ends_with(".webp"), "got {fname}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_capture_png_uses_mode_and_window_template() {
        let dir = std::env::temp_dir().join(format!("clippity-capture-io-tpl-{}", next_id()));
        // Blank template => the mode + window default. A real local time
        // is stamped, so assert on the recognisable prefix + extension
        // rather than the exact timestamp.
        let source = CaptureSource::from_mode("Fullscreen")
            .with_window(Some("GitHub - Chrome"), Some("Chrome"));
        let path = save_capture_png(&dir, b"x", "", &source).expect("save ok");
        let fname = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            fname.starts_with("Fullscreen - GitHub - Chrome - "),
            "got {fname}"
        );
        assert!(fname.ends_with(".png"), "got {fname}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_capture_png_falls_back_to_type_without_window() {
        let dir = std::env::temp_dir().join(format!("clippity-capture-io-tpl2-{}", next_id()));
        let path =
            save_capture_png(&dir, b"x", "", &CaptureSource::from_mode("Region")).expect("save ok");
        let fname = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(fname.starts_with("Region - "), "got {fname}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------- provenance sidecar (written by construction) ----------

    #[test]
    fn saving_a_capture_records_its_provenance() {
        let dir = std::env::temp_dir().join(format!("clippity-capture-io-meta-{}", next_id()));
        let source = CaptureSource::from_mode("Region")
            .with_window(Some("GitHub - Chrome"), Some("Chrome"))
            .with_size(1920, 1080);
        let path = save_capture_png(&dir, b"x", "", &source).expect("save ok");

        let meta = sidecar::read_metadata(&path).expect("a sidecar was written");
        assert_eq!(meta.mode, "Region");
        assert_eq!(meta.source_app.as_deref(), Some("Chrome"));
        assert_eq!(meta.source_window.as_deref(), Some("GitHub - Chrome"));
        assert_eq!((meta.width, meta.height), (Some(1920), Some(1080)));
        // The record names the file actually written, collision suffix
        // included — not the stem the template rendered.
        assert_eq!(
            meta.file,
            path.file_name().unwrap().to_string_lossy().into_owned()
        );
        assert!(meta.captured_at_ms > 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn colliding_captures_get_their_own_records() {
        // Two captures rendering the same stem land as `Shot.png` and
        // `Shot (2).png`; each must describe itself, not the other.
        let dir = std::env::temp_dir().join(format!("clippity-capture-io-meta2-{}", next_id()));
        let a = save_capture_png(&dir, b"a", "Shot", &CaptureSource::from_mode("Region"))
            .expect("first ok");
        let b = save_capture_png(&dir, b"b", "Shot", &CaptureSource::from_mode("Window"))
            .expect("second ok");

        assert_eq!(sidecar::read_metadata(&a).unwrap().file, "Shot.png");
        assert_eq!(sidecar::read_metadata(&b).unwrap().file, "Shot (2).png");
        assert_eq!(sidecar::read_metadata(&a).unwrap().mode, "Region");
        assert_eq!(sidecar::read_metadata(&b).unwrap().mode, "Window");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_record_lands_beside_the_capture_wherever_it_was_saved() {
        // A preset can pin an output folder (ADR 0004); the sidecar is
        // parent-relative, so it follows the capture there rather than
        // staying behind in the captures root.
        let dir = std::env::temp_dir()
            .join(format!("clippity-capture-io-meta3-{}", next_id()))
            .join("preset-output");
        let path =
            save_capture_png(&dir, b"x", "", &CaptureSource::from_mode("Region")).expect("save ok");
        assert!(dir.join(".meta").is_dir(), "sidecar dir beside the capture");
        assert!(sidecar::read_metadata(&path).is_some());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn the_hidden_record_dir_is_not_mistaken_for_a_capture() {
        // `.meta` is dot-prefixed for the same reason `.scenes` is: the
        // library scan skips dot entries, so records never list as rows.
        assert!(sidecar::METADATA_DIRNAME.starts_with('.'));
    }

    #[test]
    fn normalize_clipboard_text_trims_and_rejects_blank() {
        assert_eq!(normalize_clipboard_text("  hi  "), Some("hi".to_owned()));
        // Internal indentation is preserved; only outer whitespace goes.
        assert_eq!(
            normalize_clipboard_text("\n  a\n    b\n"),
            Some("a\n    b".to_owned())
        );
        assert_eq!(normalize_clipboard_text(""), None);
        assert_eq!(normalize_clipboard_text("   \t\n "), None);
    }

    #[test]
    fn thumbnail_data_uri_encodes_png_and_downscales() {
        // 200×100 → longest edge clamped to 64 → 64×32.
        let img = RgbaImage::new(200, 100);
        let uri = thumbnail_data_uri(&img, 64);
        assert!(uri.starts_with("data:image/png;base64,"), "got {uri}");
        let b64 = uri.strip_prefix("data:image/png;base64,").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("valid base64");
        let decoded = image::load_from_memory(&bytes).expect("valid png");
        assert_eq!((decoded.width(), decoded.height()), (64, 32));
    }

    #[test]
    fn thumbnail_data_uri_keeps_small_images_unscaled() {
        let img = RgbaImage::new(48, 24);
        let uri = thumbnail_data_uri(&img, 96);
        let b64 = uri.strip_prefix("data:image/png;base64,").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (48, 24));
    }
}
