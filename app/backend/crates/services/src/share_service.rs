//! OS-level share hand-off for a capture that is already on disk.
//!
//! Everything here operates on a path the caller just saved — this
//! service never captures, encodes, or uploads. It is the file-system
//! half of [Sharing Phase 1/2](../../../../docs/roadmaps/sharing-export.md);
//! network destinations land later behind the same `ShareTarget` enum.
//!
//! Free functions rather than a struct: there is no state to hold and
//! nothing to inject, so `AppState` doesn't carry a share service.

use std::path::Path;

use crate::capture_io::copy_text_to_clipboard;
use clippity_domain::library;
use clippity_domain::share::ShareTarget;
use clippity_infra::error::{AppError, AppResult};

/// Hand the capture at `id` to `target`.
///
/// `id` is checked against `captures_root` before anything touches it.
/// That check is the security boundary, not a tidiness one:
/// [`ShareTarget::Open`] hands the file to the shell's registered
/// handler, and the shell's handler for an executable is "run it", so an
/// id that escaped the captures root would turn any scripting of the
/// webview into arbitrary local execution. Same `validate_id` every other
/// id-taking service call uses.
///
/// The file must also exist: every target is a silent no-op or a
/// confusing OS-level error otherwise (Explorer opens the wrong folder,
/// the clipboard gets a path to nothing), so this fails loudly instead.
pub fn share(id: &str, captures_root: &Path, target: ShareTarget) -> AppResult<()> {
    let path = library::validate_id(id, captures_root)?;
    let path = path.as_path();
    if !path.is_file() {
        return Err(AppError::Share(format!(
            "{} is not a file that can be shared",
            path.display()
        )));
    }

    match target {
        ShareTarget::Reveal => {
            tauri_plugin_opener::reveal_item_in_dir(path)
                .map_err(|e| AppError::Share(format!("reveal in folder: {e}")))?;
        }
        ShareTarget::Open => {
            // `None` = whatever the OS has registered for the extension.
            tauri_plugin_opener::open_path(path, None::<&str>)
                .map_err(|e| AppError::Share(format!("open: {e}")))?;
        }
        ShareTarget::CopyPath => {
            // `display()` is lossy for non-UTF-8 paths, but the clipboard
            // is text — there is nothing better to put there, and the
            // captures dir is app-controlled in practice.
            copy_text_to_clipboard(&path.display().to_string())
                .map_err(|e| AppError::Share(format!("copy path: {e}")))?;
        }
    }

    tracing::debug!(target = target.label(), path = %path.display(), "capture shared");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A temp path no other test can be holding.
    ///
    /// Deliberately not `next_id()`: that is a millisecond timestamp, and
    /// these tests run in parallel, so two of them landing in the same
    /// millisecond get the same path — and then one deletes it out from
    /// under the other on its way out. That surfaces as a spurious
    /// `AlreadyExists` or a vanished directory, neither of which has
    /// anything to do with what the test is checking. Same pid + nonce
    /// scheme the `clippity-media` scheme's tests use, for the same
    /// reason.
    fn unique(prefix: &str) -> std::path::PathBuf {
        static NONCE: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            NONCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// A captures root that actually exists, so "outside the root" is the
    /// only reason a rejection can happen in the tests below.
    fn root() -> std::path::PathBuf {
        let dir = unique("clippity-share-root");
        std::fs::create_dir_all(&dir).expect("temp captures root");
        dir
    }

    #[test]
    fn share_rejects_a_path_that_is_not_a_file() {
        let root = root();
        let missing = root.join("not-here.png").to_string_lossy().into_owned();
        // Every target refuses equally — the guard is before the match.
        for t in [
            ShareTarget::Reveal,
            ShareTarget::Open,
            ShareTarget::CopyPath,
        ] {
            let err = share(&missing, &root, t).unwrap_err();
            assert_eq!(err.code(), "share");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn share_rejects_a_directory() {
        let root = root();
        let sub = root.join("a-folder");
        std::fs::create_dir_all(&sub).expect("subdir");
        assert!(share(&sub.to_string_lossy(), &root, ShareTarget::Reveal).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn share_refuses_an_id_outside_the_captures_root() {
        // `Open` hands the file to the shell, so an id that escaped the
        // root would be arbitrary local execution. It has to be refused
        // before the `is_file` check, not after — an attacker would point
        // at a file that certainly exists.
        let root = root();
        let outside = unique("clippity-outside").with_extension("png");
        std::fs::write(&outside, b"x").expect("write");

        for t in [
            ShareTarget::Reveal,
            ShareTarget::Open,
            ShareTarget::CopyPath,
        ] {
            let err = share(&outside.to_string_lossy(), &root, t).unwrap_err();
            assert_eq!(err.code(), "library", "target {t:?}");
        }

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn share_refuses_a_parent_traversal_out_of_the_captures_root() {
        let root = root();
        let escape = format!("{}/../evil.exe", root.display());
        let err = share(&escape, &root, ShareTarget::Open).unwrap_err();
        assert_eq!(err.code(), "library");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_path_puts_the_absolute_path_on_the_clipboard() {
        // Clipboard access needs a desktop session; skip where there
        // isn't one rather than failing the suite on a headless runner.
        if arboard::Clipboard::new().is_err() {
            return;
        }
        let dir = unique("clippity-share");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("Shot.png");
        std::fs::write(&file, b"x").expect("write");

        share(&file.to_string_lossy(), &dir, ShareTarget::CopyPath).expect("copy-path ok");
        let mut cb = arboard::Clipboard::new().expect("clipboard");
        assert_eq!(cb.get_text().expect("text"), file.display().to_string());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
