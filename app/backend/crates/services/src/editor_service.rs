//! Editor orchestration — open a capture from disk, save an edited
//! capture back to the captures dir.
//!
//! Validation: every `id` is run through `library::validate_id` so
//! the editor cannot read or write outside the captures directory
//! (defense against malicious IPC payloads — same guard `library`
//! uses).
//!
//! Concurrency: no service-side state. Each call is independent.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use image::ImageReader;

use crate::capture_io;
use crate::settings_service::{CapturesDirSource, NameTemplateSource};
use crate::sidecar::{self, SCENES_DIRNAME};
use clippity_domain::editor::{self, EditorImage};
use clippity_domain::library;
use clippity_domain::metadata::CaptureSource;
use clippity_infra::error::{AppError, AppResult};

pub struct EditorService {
    captures: Arc<dyn CapturesDirSource>,
    naming: Arc<dyn NameTemplateSource>,
}

impl EditorService {
    pub fn new(captures: Arc<dyn CapturesDirSource>, naming: Arc<dyn NameTemplateSource>) -> Self {
        Self { captures, naming }
    }

    /// Load the capture at `id` as a base64 image data URI plus the
    /// decoded dimensions so the frontend canvas can size itself
    /// without a second roundtrip. The MIME is read from the file's
    /// extension — a `.jpg`/`.webp` capture must not be announced as
    /// PNG or the webview may refuse to decode it. If an editable scene
    /// sidecar exists for this capture it rides along in `scene` so the
    /// editor can restore the editable document instead of the flat image.
    pub fn load(&self, id: &str) -> AppResult<EditorImage> {
        library::validate_id(id, &self.captures.captures_dir())?;
        let bytes = fs::read(id).map_err(|e| AppError::Editor(format!("read: {e}")))?;
        let (width, height) = decode_dimensions(id)?;
        let mime = editor::mime_for_path(id);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        // Best-effort: a missing/unreadable sidecar just means "no saved
        // scene" — never fail the load over it.
        let scene = self
            .scene_path(id)
            .ok()
            .and_then(|p| fs::read_to_string(p).ok());
        Ok(EditorImage {
            id: id.to_string(),
            data_uri: format!("data:{mime};base64,{b64}"),
            width,
            height,
            scene,
        })
    }

    /// Persist the editor's editable scene (an opaque JSON document — the
    /// frontend owns the format) as a sidecar next to the capture `id`,
    /// under the hidden `.scenes` dir. Non-destructive: the original
    /// capture file is untouched, so the source pixels are never lost.
    /// Returns the sidecar's absolute path.
    pub fn save_scene(&self, id: &str, scene_json: &str) -> AppResult<String> {
        let path = self.scene_path(id)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AppError::Editor(format!("create .scenes dir: {e}")))?;
        }
        fs::write(&path, scene_json).map_err(|e| AppError::Editor(format!("write scene: {e}")))?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// Absolute path of the scene sidecar for capture `id`. Validates the
    /// capture id stays inside the captures dir first (so a malicious IPC
    /// payload can't write JSON anywhere on disk).
    ///
    /// Resolved through `services::sidecar`, which hangs a sidecar off the
    /// capture's **own** directory rather than the captures root. For a
    /// capture sitting directly in the root — every capture the library
    /// lists — the two are the same path. They diverge for a capture that
    /// has moved (to `.trash`, say), and there the parent-relative answer
    /// is the correct one: it's where `sidecar::relocate` carried the
    /// document, and it's the same rule the `.meta` record follows, which
    /// is what lets one relocation move both (ADR 0026).
    fn scene_path(&self, id: &str) -> AppResult<PathBuf> {
        library::validate_id(id, &self.captures.captures_dir())?;
        sidecar::path_for(Path::new(id), SCENES_DIRNAME)
            .ok_or_else(|| AppError::Editor("capture path has no parent directory".into()))
    }

    /// Persist a flattened image (the frontend has already baked
    /// annotations + effects into pixels) as a new capture in the
    /// captures dir. The data URI's declared format picks the on-disk
    /// extension — PNG, JPEG or WebP; the bytes are written exactly as
    /// the canvas encoded them, never transcoded. Returns the new
    /// absolute path. Caller is responsible for emitting `LIBRARY_UPDATED`.
    pub fn save(&self, data_uri: &str) -> AppResult<String> {
        let payload = editor::parse_image_data_uri(data_uri).ok_or_else(|| {
            AppError::Editor("expected data:image/{png|jpeg|webp};base64,... payload".into())
        })?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload.base64)
            .map_err(|e| AppError::Editor(format!("base64 decode: {e}")))?;
        // An edited export has no source window — the name falls back to
        // the "Edited" type label + timestamp, and the provenance record
        // carries the mode alone. Dimensions stay unrecorded rather than
        // paying a full decode of bytes we deliberately never inspect.
        let path = capture_io::save_capture_image(
            &self.captures.captures_dir(),
            &bytes,
            &self.naming.name_template(),
            &CaptureSource::from_mode("Edited"),
            payload.format.extension(),
        )
        .map_err(|e| AppError::Editor(format!("save: {e}")))?;
        Ok(path.to_string_lossy().into_owned())
    }
}

fn decode_dimensions(path: &str) -> AppResult<(u32, u32)> {
    let reader = ImageReader::open(path)
        .map_err(|e| AppError::Editor(format!("open: {e}")))?
        .with_guessed_format()
        .map_err(|e| AppError::Editor(format!("sniff: {e}")))?;
    let (w, h) = reader
        .into_dimensions()
        .map_err(|e| AppError::Editor(format!("dimensions: {e}")))?;
    Ok((w, h))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings_service::{StaticCapturesDir, StaticNameTemplate};
    use image::{ImageBuffer, ImageFormat, Rgba};
    use std::io::Cursor;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Reused hermetic test harness — same shape as `library_service`'s.
    struct TestHarness {
        root: PathBuf,
        captures: PathBuf,
        service: EditorService,
    }

    impl Drop for TestHarness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    static TEST_NONCE: AtomicU64 = AtomicU64::new(0);

    fn harness() -> TestHarness {
        let n = TEST_NONCE.fetch_add(1, Ordering::Relaxed);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("clippity-editor-test-{ts}-{n}"));
        let captures = root.join("captures");
        fs::create_dir_all(&captures).unwrap();
        let captures_src: Arc<dyn CapturesDirSource> =
            Arc::new(StaticCapturesDir(captures.clone()));
        let naming: Arc<dyn NameTemplateSource> = Arc::new(StaticNameTemplate(String::new()));
        TestHarness {
            service: EditorService::new(captures_src, naming),
            captures,
            root,
        }
    }

    fn write_tiny_png(dir: &std::path::Path, name: &str) -> PathBuf {
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_pixel(4, 3, Rgba([10, 20, 30, 255]));
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
            .unwrap();
        let path = dir.join(name);
        fs::write(&path, &buf).unwrap();
        path
    }

    #[test]
    fn load_returns_data_uri_and_dimensions() {
        let h = harness();
        let p = write_tiny_png(&h.captures, "x.png");
        let img = h.service.load(&p.to_string_lossy()).expect("load ok");
        assert!(img.data_uri.starts_with("data:image/png;base64,"));
        assert_eq!(img.width, 4);
        assert_eq!(img.height, 3);
    }

    #[test]
    fn load_rejects_path_outside_captures_root() {
        let h = harness();
        let err = h.service.load("/etc/passwd").unwrap_err();
        assert_eq!(err.code(), "library");
    }

    #[test]
    fn save_round_trips_through_disk() {
        let h = harness();
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_pixel(2, 2, Rgba([0, 128, 255, 255]));
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
            .unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        let data_uri = format!("data:image/png;base64,{b64}");

        let path = h.service.save(&data_uri).expect("save ok");
        let saved = fs::read(&path).expect("read back");
        assert_eq!(saved, buf);
        let fname = std::path::Path::new(&path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        // No source window in a headless test → the "Edited" type label.
        assert!(fname.starts_with("Edited - "), "got {fname}");
        assert!(fname.ends_with(".png"));
    }

    #[test]
    fn save_writes_jpeg_and_webp_under_their_own_extensions() {
        let h = harness();
        for (mime, ext) in [("jpeg", "jpg"), ("webp", "webp")] {
            // The backend never decodes an export — it persists exactly
            // what the canvas encoded — so opaque bytes are enough here.
            let bytes = format!("fake-{mime}-bytes").into_bytes();
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let path = h
                .service
                .save(&format!("data:image/{mime};base64,{b64}"))
                .unwrap_or_else(|e| panic!("save {mime}: {e:?}"));

            assert_eq!(fs::read(&path).unwrap(), bytes, "bytes for {mime}");
            let fname = std::path::Path::new(&path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            assert!(fname.starts_with("Edited - "), "got {fname}");
            assert!(fname.ends_with(&format!(".{ext}")), "got {fname}");
        }
    }

    #[test]
    fn save_rejects_a_format_the_editor_cannot_write() {
        let h = harness();
        // GIF is a real image format the library can *hold*, but the
        // editor never encodes it — saving one would mislabel the file.
        let err = h.service.save("data:image/gif;base64,abc").unwrap_err();
        assert_eq!(err.code(), "editor");
        let err = h.service.save("data:text/plain;base64,abc").unwrap_err();
        assert_eq!(err.code(), "editor");
    }

    #[test]
    fn load_declares_the_mime_matching_the_file_extension() {
        let h = harness();
        // A JPEG capture must not come back announced as PNG.
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_pixel(4, 3, Rgba([10, 20, 30, 255]));
        let mut buf = Vec::new();
        // JPEG has no alpha channel — drop it before encoding.
        let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
        image::DynamicImage::ImageRgb8(rgb)
            .write_to(&mut Cursor::new(&mut buf), ImageFormat::Jpeg)
            .unwrap();
        let path = h.captures.join("Shot.jpg");
        fs::write(&path, &buf).unwrap();

        let loaded = h.service.load(&path.to_string_lossy()).expect("load ok");
        assert!(
            loaded.data_uri.starts_with("data:image/jpeg;base64,"),
            "got {}",
            &loaded.data_uri[..40.min(loaded.data_uri.len())]
        );
        assert_eq!((loaded.width, loaded.height), (4, 3));
    }

    #[test]
    fn save_rejects_bad_base64() {
        let h = harness();
        let err = h
            .service
            .save("data:image/png;base64,!!!not-base64!!!")
            .unwrap_err();
        assert_eq!(err.code(), "editor");
    }

    #[test]
    fn save_scene_writes_sidecar_and_load_reads_it_back() {
        let h = harness();
        let p = write_tiny_png(&h.captures, "Shot.png");
        let id = p.to_string_lossy().into_owned();
        let doc = r#"{"version":1,"docName":"Shot","rootIds":[],"nodes":{}}"#;

        let sidecar = h.service.save_scene(&id, doc).expect("save scene ok");
        // The sidecar lives in the hidden .scenes dir, named <file>.json.
        assert!(sidecar
            .replace('\\', "/")
            .ends_with("/.scenes/Shot.png.json"));
        assert_eq!(fs::read_to_string(&sidecar).unwrap(), doc);

        // load() rides the saved scene back to the frontend.
        let img = h.service.load(&id).expect("load ok");
        assert_eq!(img.scene.as_deref(), Some(doc));
    }

    #[test]
    fn load_without_sidecar_has_no_scene() {
        let h = harness();
        let p = write_tiny_png(&h.captures, "Plain.png");
        let img = h.service.load(&p.to_string_lossy()).expect("load ok");
        assert!(img.scene.is_none());
    }

    #[test]
    fn save_scene_rejects_path_outside_captures_root() {
        let h = harness();
        let err = h.service.save_scene("/etc/evil.png", "{}").unwrap_err();
        assert_eq!(err.code(), "library");
    }

    #[test]
    fn a_trashed_captures_scene_is_read_from_beside_it() {
        // `sidecar::relocate` carries the document into `.trash/.scenes`
        // when a capture is trashed; the editor must look there, not in
        // the captures root, or a restore-then-open would come back flat.
        let h = harness();
        let trash = h.captures.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        let p = write_tiny_png(&trash, "Trashed.png");
        let id = p.to_string_lossy().into_owned();
        let doc = r#"{"version":1,"rootIds":[]}"#;

        let sidecar_path = h.service.save_scene(&id, doc).expect("save scene ok");
        assert!(
            sidecar_path
                .replace('\\', "/")
                .ends_with("/.trash/.scenes/Trashed.png.json"),
            "got {sidecar_path}"
        );
        assert_eq!(h.service.load(&id).unwrap().scene.as_deref(), Some(doc));
    }
}
