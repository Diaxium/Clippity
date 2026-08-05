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
use clippity_domain::share::ShareTarget;
use clippity_infra::error::{AppError, AppResult};

/// Hand `path` to `target`.
///
/// The file must exist: every target is a silent no-op or a confusing
/// OS-level error otherwise (Explorer opens the wrong folder, the
/// clipboard gets a path to nothing), so this fails loudly instead.
pub fn share(path: &Path, target: ShareTarget) -> AppResult<()> {
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
    use crate::capture_io::next_id;

    #[test]
    fn share_rejects_a_path_that_is_not_a_file() {
        let missing = std::env::temp_dir().join(format!("clippity-share-missing-{}", next_id()));
        // Every target refuses equally — the guard is before the match.
        for t in [
            ShareTarget::Reveal,
            ShareTarget::Open,
            ShareTarget::CopyPath,
        ] {
            let err = share(&missing, t).unwrap_err();
            assert_eq!(err.code(), "share");
        }
    }

    #[test]
    fn share_rejects_a_directory() {
        let dir = std::env::temp_dir();
        assert!(share(&dir, ShareTarget::Reveal).is_err());
    }

    #[test]
    fn copy_path_puts_the_absolute_path_on_the_clipboard() {
        // Clipboard access needs a desktop session; skip where there
        // isn't one rather than failing the suite on a headless runner.
        if arboard::Clipboard::new().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("clippity-share-{}", next_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("Shot.png");
        std::fs::write(&file, b"x").expect("write");

        share(&file, ShareTarget::CopyPath).expect("copy-path ok");
        let mut cb = arboard::Clipboard::new().expect("clipboard");
        assert_eq!(cb.get_text().expect("text"), file.display().to_string());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
