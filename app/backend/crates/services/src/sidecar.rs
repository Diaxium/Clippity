//! Sidecar files — the small records that live *beside* a capture
//! rather than inside it, and the rules that keep them attached to it.
//!
//! Three families exist today, all hidden subdirectories of whatever
//! directory the capture itself landed in:
//!
//! - [`METADATA_DIRNAME`] (`.meta`) — the provenance record written at
//!   save time (`domain::metadata`): source app + window, capture mode,
//!   timestamp, dimensions.
//! - [`SCENES_DIRNAME`] (`.scenes`) — the editor's editable scene
//!   document (ADR 0017), written when a capture is saved from the
//!   editor.
//! - [`LABELS_DIRNAME`] (`.labels`) — the user's tags and favorite flag
//!   (`domain::labels`, ADR 0029), rewritten whenever they are edited.
//!   Deliberately *not* folded into `.meta`: provenance is written once
//!   and never touched again, and a tag edit has no business rewriting a
//!   record of what happened at capture time.
//!
//! **Sidecars are resolved against the capture's own parent directory,
//! not the captures root.** A preset can pin an output folder (ADR
//! 0004) and the trash is a subdirectory, so a root-relative layout
//! would strand the record the first time a capture landed anywhere
//! else. Parent-relative means the pair travels together by
//! construction — `<dir>/Shot.png` ↔ `<dir>/.meta/Shot.png.json` — and
//! `.trash/` gets its own `.meta`/`.scenes` for the same reason.
//!
//! Both families use `library::sidecar_file_name`, so a capture's
//! sidecars always share one name. That is what lets [`relocate`] and
//! [`remove`] treat the whole set generically: a file op on a capture
//! carries *every* sidecar it has, present or future, without each new
//! family having to be wired into trash/restore/purge separately.
//!
//! Every operation here is **best-effort**. A missing, unreadable, or
//! unwritable sidecar must never fail the capture, the trash move, or
//! the library listing — the pixels are the product; this is
//! description. Failures are logged and swallowed. The one exception is
//! [`write_metadata`], which surfaces its error so a caller that
//! genuinely wants to know can look — the capture pipelines log and
//! continue.

use std::fs;
use std::path::{Path, PathBuf};

use clippity_domain::labels::CaptureLabels;
use clippity_domain::library;
use clippity_domain::metadata::CaptureMetadata;
use clippity_infra::error::{AppError, AppResult};

/// Hidden subdir holding per-capture provenance records.
pub const METADATA_DIRNAME: &str = ".meta";

/// Hidden subdir holding the editor's editable-scene documents (ADR 0017).
pub const SCENES_DIRNAME: &str = ".scenes";

/// Hidden subdir holding per-capture tags + favorite flag (ADR 0029).
pub const LABELS_DIRNAME: &str = ".labels";

/// Hidden subdir holding poster frames for recordings (ADR 0031).
///
/// A video has no first-frame the `image` crate can decode, so the
/// library would show a placeholder where every other row shows a
/// picture. The recorder writes one frame here as it starts, which
/// costs a single PNG encode per session and means listing a library
/// full of recordings never has to open a video decoder.
pub const POSTERS_DIRNAME: &str = ".posters";

/// Every sidecar family, in the order file ops walk them. Adding a
/// family here is all it takes for trash / restore / purge to carry it.
pub const SIDECAR_DIRNAMES: [&str; 4] = [
    METADATA_DIRNAME,
    SCENES_DIRNAME,
    LABELS_DIRNAME,
    POSTERS_DIRNAME,
];

/// Absolute path of `capture_path`'s sidecar in `dirname`, or `None`
/// when the capture path has no parent directory to hang one off.
pub fn path_for(capture_path: &Path, dirname: &str) -> Option<PathBuf> {
    let parent = capture_path.parent()?;
    let name = library::sidecar_file_name(&capture_path.to_string_lossy());
    Some(parent.join(dirname).join(name))
}

/// Write `meta` as the capture's `.meta` record, creating the hidden
/// directory if needed. Pretty-printed: these are small, and a user who
/// opens one should be able to read it.
pub fn write_metadata(capture_path: &Path, meta: &CaptureMetadata) -> AppResult<()> {
    let path = path_for(capture_path, METADATA_DIRNAME)
        .ok_or_else(|| AppError::Library("capture path has no parent directory".into()))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::Library(format!("create {METADATA_DIRNAME} dir: {e}")))?;
    }
    let json = serde_json::to_vec_pretty(meta)
        .map_err(|e| AppError::Library(format!("serialize metadata: {e}")))?;
    fs::write(&path, json).map_err(|e| AppError::Library(format!("write metadata: {e}")))
}

/// Read the capture's provenance record, or `None` when there isn't one
/// (every capture saved before sidecars existed), it can't be read, or
/// it doesn't parse. All three are the same answer to the library:
/// nothing extra to show.
pub fn read_metadata(capture_path: &Path) -> Option<CaptureMetadata> {
    let path = path_for(capture_path, METADATA_DIRNAME)?;
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<CaptureMetadata>(&bytes).ok()
}

/// Where a capture's poster frame lives.
///
/// Deliberately **not** [`path_for`]: that appends `.json`, which is
/// right for the three record families and wrong for image bytes — the
/// `image` crate picks its decoder from the extension, so a PNG named
/// `.json` is one it refuses to open. Posters get `.png` instead.
fn poster_path_for(capture_path: &Path) -> Option<PathBuf> {
    let parent = capture_path.parent()?;
    let name = capture_path.file_name()?.to_string_lossy().into_owned();
    Some(parent.join(POSTERS_DIRNAME).join(format!("{name}.png")))
}

/// Write a capture's poster frame — already-encoded PNG bytes.
///
/// Best-effort by the same reasoning as the metadata record: a poster
/// that cannot be written costs the library a thumbnail, and a
/// thumbnail is description. The recording is the product.
pub fn write_poster(capture_path: &Path, png: &[u8]) -> AppResult<()> {
    let path = poster_path_for(capture_path)
        .ok_or_else(|| AppError::Library("capture path has no parent directory".into()))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::Library(format!("create {POSTERS_DIRNAME} dir: {e}")))?;
    }
    fs::write(&path, png).map_err(|e| AppError::Library(format!("write poster: {e}")))
}

/// Path of a capture's poster frame, if one was written.
pub fn poster_path(capture_path: &Path) -> Option<PathBuf> {
    let path = poster_path_for(capture_path)?;
    path.is_file().then_some(path)
}

/// Write the capture's label record, or **delete** it when there is
/// nothing left to say ([`CaptureLabels::is_empty`]).
///
/// Removing a capture's last tag has to leave the same filesystem state
/// as never having tagged it. An empty record left behind would keep the
/// library index stamping a sidecar mtime the row no longer depends on,
/// and would leave `.labels` littered with `{}` for every capture that
/// was ever starred and unstarred.
pub fn write_labels(capture_path: &Path, labels: &CaptureLabels) -> AppResult<()> {
    let path = path_for(capture_path, LABELS_DIRNAME)
        .ok_or_else(|| AppError::Library("capture path has no parent directory".into()))?;
    if labels.is_empty() {
        return match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::Library(format!("remove labels: {e}"))),
        };
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::Library(format!("create {LABELS_DIRNAME} dir: {e}")))?;
    }
    let json = serde_json::to_vec_pretty(labels)
        .map_err(|e| AppError::Library(format!("serialize labels: {e}")))?;
    fs::write(&path, json).map_err(|e| AppError::Library(format!("write labels: {e}")))
}

/// Read the capture's label record, or `None` when it has none, it can't
/// be read, or it doesn't parse — all the same answer to the library:
/// an untagged, unfavorited capture.
pub fn read_labels(capture_path: &Path) -> Option<CaptureLabels> {
    let path = path_for(capture_path, LABELS_DIRNAME)?;
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<CaptureLabels>(&bytes).ok()
}

/// Move every sidecar belonging to `from` alongside `to` — the trash
/// and restore moves. Best-effort per family: a capture with no scene
/// document simply has nothing to move there.
///
/// Called *after* the capture itself has moved, so a failure here
/// leaves the capture correct and only its description behind.
pub fn relocate(from: &Path, to: &Path) {
    for dirname in SIDECAR_DIRNAMES {
        let (Some(src), Some(dst)) = (path_for(from, dirname), path_for(to, dirname)) else {
            continue;
        };
        if !src.exists() {
            continue;
        }
        if let Some(parent) = dst.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                tracing::warn!("sidecar {dirname}: create dest dir failed: {e}");
                continue;
            }
        }
        if let Err(e) = fs::rename(&src, &dst) {
            tracing::warn!("sidecar {dirname}: move failed: {e}");
        }
    }
}

/// Delete every sidecar belonging to `path` — the permanent-delete
/// counterpart of [`relocate`]. Best-effort; a missing one is success.
pub fn remove(path: &Path) {
    for dirname in SIDECAR_DIRNAMES {
        let Some(sidecar) = path_for(path, dirname) else {
            continue;
        };
        match fs::remove_file(&sidecar) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!("sidecar {dirname}: remove failed: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clippity_domain::labels::CaptureLabels;
    use clippity_domain::metadata::{self, CaptureSource};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Hermetic temp root, removed on Drop — the same no-extra-crate
    /// harness shape `capture_io` and `library_service` use.
    struct TempDir(PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    static NONCE: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> TempDir {
        let n = NONCE.fetch_add(1, Ordering::Relaxed);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("clippity-sidecar-{ts}-{n}"));
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn sample(file: &str) -> CaptureMetadata {
        let src = CaptureSource::from_mode("Region")
            .with_window(Some("GitHub - Chrome"), Some("Chrome"))
            .with_size(800, 600);
        metadata::build(&src, file, 1_700_000_000_000)
    }

    #[test]
    fn path_for_hangs_the_sidecar_off_the_captures_own_directory() {
        let p = Path::new("/caps/sub/Shot.png");
        let meta = path_for(p, METADATA_DIRNAME).unwrap();
        assert_eq!(meta, PathBuf::from("/caps/sub/.meta/Shot.png.json"));
        let scene = path_for(p, SCENES_DIRNAME).unwrap();
        assert_eq!(scene, PathBuf::from("/caps/sub/.scenes/Shot.png.json"));
        let labels = path_for(p, LABELS_DIRNAME).unwrap();
        assert_eq!(labels, PathBuf::from("/caps/sub/.labels/Shot.png.json"));
    }

    #[test]
    fn every_family_shares_one_file_name() {
        // relocate() relies on this: it moves each family by the same
        // name, so a divergence would silently orphan one of them.
        let p = Path::new("/caps/Shot.png");
        let names: Vec<_> = SIDECAR_DIRNAMES
            .iter()
            .map(|d| path_for(p, d).unwrap().file_name().unwrap().to_owned())
            .collect();
        assert!(names.windows(2).all(|w| w[0] == w[1]), "got {names:?}");
    }

    #[test]
    fn write_then_read_round_trips() {
        let t = temp_dir();
        let capture = t.0.join("Shot.png");
        fs::write(&capture, b"pixels").unwrap();

        write_metadata(&capture, &sample("Shot.png")).expect("write ok");
        let back = read_metadata(&capture).expect("read ok");
        assert_eq!(back.mode, "Region");
        assert_eq!(back.source_app.as_deref(), Some("Chrome"));
        assert_eq!((back.width, back.height), (Some(800), Some(600)));
    }

    #[test]
    fn read_metadata_is_none_without_a_sidecar() {
        let t = temp_dir();
        let capture = t.0.join("Bare.png");
        fs::write(&capture, b"pixels").unwrap();
        assert!(read_metadata(&capture).is_none());
    }

    #[test]
    fn read_metadata_is_none_for_a_corrupt_sidecar() {
        // A truncated or hand-edited record is the same answer as no
        // record — it must not take the library listing down with it.
        let t = temp_dir();
        let capture = t.0.join("Corrupt.png");
        fs::write(&capture, b"pixels").unwrap();
        let sidecar = path_for(&capture, METADATA_DIRNAME).unwrap();
        fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        fs::write(&sidecar, b"{ not json").unwrap();
        assert!(read_metadata(&capture).is_none());
    }

    #[test]
    fn write_metadata_creates_the_hidden_directory() {
        let t = temp_dir();
        let capture = t.0.join("New.png");
        write_metadata(&capture, &sample("New.png")).expect("write ok");
        assert!(t.0.join(METADATA_DIRNAME).is_dir());
    }

    #[test]
    fn relocate_carries_every_family_into_the_destination() {
        let t = temp_dir();
        let capture = t.0.join("Move.png");
        fs::write(&capture, b"pixels").unwrap();
        write_metadata(&capture, &sample("Move.png")).unwrap();
        // A scene document, written the way editor_service does.
        let scene = path_for(&capture, SCENES_DIRNAME).unwrap();
        fs::create_dir_all(scene.parent().unwrap()).unwrap();
        fs::write(&scene, r#"{"version":1}"#).unwrap();
        // ...and the user's own labels.
        write_labels(
            &capture,
            &CaptureLabels::new("Move.png", vec!["docs".into()], true),
        )
        .unwrap();

        let trash = t.0.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        let moved = trash.join("Move.png");
        fs::rename(&capture, &moved).unwrap();
        relocate(&capture, &moved);

        // Every record followed the capture; none was left behind.
        assert_eq!(read_metadata(&moved).map(|m| m.mode), Some("Region".into()));
        assert!(path_for(&moved, SCENES_DIRNAME).unwrap().exists());
        assert_eq!(read_labels(&moved).unwrap().tags, vec!["docs".to_string()]);
        assert!(!path_for(&capture, METADATA_DIRNAME).unwrap().exists());
        assert!(!scene.exists());
        assert!(read_labels(&capture).is_none());
    }

    // ---------- labels ----------

    #[test]
    fn labels_write_then_read_round_trips() {
        let t = temp_dir();
        let capture = t.0.join("Tagged.png");
        fs::write(&capture, b"pixels").unwrap();
        let labels = CaptureLabels::new("Tagged.png", vec!["bug".into(), "docs".into()], true);
        write_labels(&capture, &labels).unwrap();
        assert_eq!(read_labels(&capture), Some(labels));
    }

    #[test]
    fn writing_empty_labels_removes_the_record() {
        // Un-starring the last label standing has to leave the same
        // filesystem state as never having labelled the capture — an
        // empty record would keep stamping a sidecar the row no longer
        // depends on.
        let t = temp_dir();
        let capture = t.0.join("Untagged.png");
        fs::write(&capture, b"pixels").unwrap();
        write_labels(&capture, &CaptureLabels::new("Untagged.png", vec![], true)).unwrap();
        let record = path_for(&capture, LABELS_DIRNAME).unwrap();
        assert!(record.exists());

        write_labels(&capture, &CaptureLabels::new("Untagged.png", vec![], false)).unwrap();
        assert!(!record.exists());
        assert!(read_labels(&capture).is_none());
        // Writing empty labels with no record to remove is not an error.
        write_labels(&capture, &CaptureLabels::new("Untagged.png", vec![], false)).unwrap();
    }

    #[test]
    fn read_labels_is_none_for_a_corrupt_record() {
        let t = temp_dir();
        let capture = t.0.join("CorruptLabels.png");
        fs::write(&capture, b"pixels").unwrap();
        let record = path_for(&capture, LABELS_DIRNAME).unwrap();
        fs::create_dir_all(record.parent().unwrap()).unwrap();
        fs::write(&record, b"{ not json").unwrap();
        assert!(read_labels(&capture).is_none());
    }

    #[test]
    fn relocate_is_silent_when_there_is_nothing_to_move() {
        let t = temp_dir();
        let from = t.0.join("Nothing.png");
        let to = t.0.join("Elsewhere.png");
        relocate(&from, &to); // must not panic
        assert!(read_metadata(&to).is_none());
    }

    #[test]
    fn remove_deletes_every_family_and_tolerates_absence() {
        let t = temp_dir();
        let capture = t.0.join("Gone.png");
        fs::write(&capture, b"pixels").unwrap();
        write_metadata(&capture, &sample("Gone.png")).unwrap();
        write_labels(
            &capture,
            &CaptureLabels::new("Gone.png", vec!["x".into()], false),
        )
        .unwrap();

        remove(&capture);
        assert!(read_metadata(&capture).is_none());
        assert!(read_labels(&capture).is_none());
        remove(&capture); // second call is a no-op, not an error
    }
}
