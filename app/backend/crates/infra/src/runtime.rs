//! Facts about *this* process that several layers ask about and nobody
//! owns: when it started, and whether it was started in safe mode.
//!
//! Process globals rather than fields on `AppState`, because both are
//! read before that state exists — safe mode has to be decided before
//! the first webview is created (it forces the GPU off, and that browser
//! arg is frozen at webview-environment creation), and the start instant
//! has to be stamped in `main` for uptime to mean anything.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

/// Marker file that asks the next launch to come up in safe mode.
///
/// A file rather than a command-line argument or an environment
/// variable: `AppHandle::restart` re-executes the binary with the
/// arguments this process was given, so there is nothing to attach a
/// flag to. The marker is consumed (deleted) by the launch that honours
/// it, which is what stops safe mode from becoming sticky after a crash
/// that happened to occur while it was armed.
pub const SAFE_MODE_MARKER: &str = "safe-mode";

static STARTED: OnceLock<Instant> = OnceLock::new();
static SAFE_MODE: AtomicBool = AtomicBool::new(false);

/// Stamp the process start. Call once, first thing in `run()`.
/// Idempotent — a second call keeps the original instant.
pub fn mark_started() {
    let _ = STARTED.set(Instant::now());
}

/// Milliseconds since [`mark_started`], or 0 when it was never called
/// (a unit test, a bench).
pub fn uptime_ms() -> u64 {
    STARTED
        .get()
        .map(|t| t.elapsed().as_millis() as u64)
        .unwrap_or(0)
}

/// Whether this process is running in safe mode.
pub fn is_safe_mode() -> bool {
    SAFE_MODE.load(Ordering::Relaxed)
}

/// Consume the marker in `data_dir`, returning whether it was there.
///
/// Deletes it first and remembers the answer for the rest of the
/// process, so every later reader (`apply_gpu_preference`, the setup
/// hook, the diagnostics command) agrees without re-touching the disk.
pub fn consume_safe_mode_marker(data_dir: &Path) -> bool {
    let marker = data_dir.join(SAFE_MODE_MARKER);
    let armed = marker.is_file();
    if armed {
        // A marker that cannot be deleted would make safe mode sticky —
        // worth a log line, but not worth refusing to boot over.
        if let Err(e) = std::fs::remove_file(&marker) {
            tracing::warn!(error = %e, "safe-mode marker could not be cleared");
        }
        SAFE_MODE.store(true, Ordering::Relaxed);
    }
    armed
}

/// Arm safe mode for the **next** launch.
pub fn arm_safe_mode(data_dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(data_dir)?;
    let marker = data_dir.join(SAFE_MODE_MARKER);
    std::fs::write(&marker, b"Delete this file to start Clippity normally.\n")?;
    Ok(marker)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("clippity-runtime-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn no_marker_means_an_ordinary_launch() {
        let dir = scratch("absent");
        assert!(!consume_safe_mode_marker(&dir));
    }

    #[test]
    fn arming_then_consuming_reports_safe_mode_once() {
        let dir = scratch("armed");
        arm_safe_mode(&dir).unwrap();
        assert!(dir.join(SAFE_MODE_MARKER).is_file());

        assert!(consume_safe_mode_marker(&dir));
        // Consumed: a crash while safe mode was armed must not make the
        // next five launches safe-mode too.
        assert!(!dir.join(SAFE_MODE_MARKER).exists());
        assert!(!consume_safe_mode_marker(&dir));
    }

    #[test]
    fn a_directory_named_like_the_marker_does_not_arm_safe_mode() {
        // Same reasoning as the portable marker: `is_file`, not `exists`.
        let dir = scratch("marker-dir");
        std::fs::create_dir_all(dir.join(SAFE_MODE_MARKER)).unwrap();
        assert!(!consume_safe_mode_marker(&dir));
    }
}
