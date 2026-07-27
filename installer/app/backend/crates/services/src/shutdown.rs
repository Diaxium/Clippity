//! Clearing the file locks that would otherwise block a maintenance step.
//!
//! Before uninstall deletes the application, or update replaces it, the
//! files may be held open by a running Clippity. This module enumerates the
//! holders with Windows Restart Manager (via `installer-platform`), asks the
//! pure [`ShutdownPlan`] which of them are ours, and — as the controlled
//! fallback the task permits for *Clippity-owned* processes only — stops
//! them so the file operation can proceed. Unrelated user applications and
//! system/Explorer processes are never touched; they are reported so the
//! caller can surface them and fall back to a reboot rather than claiming an
//! unqualified success.
//!
//! The preferred first move is still an authenticated maintenance-shutdown
//! IPC that lets the app save state before exiting (task Phase 8); that
//! handshake is a documented follow-up. Until it exists, force-terminating
//! our own processes during a user-initiated uninstall/update is the
//! correct, bounded fallback.

use std::path::Path;
use std::time::Duration;

use installer_domain::shutdown::ShutdownPlan;
use installer_platform::windows_ops;

/// Product executables owned by Clippity. Used only as the name fallback in
/// classification when a locking process's image path cannot be resolved
/// (the path-under-a-Clippity-root test is the primary signal).
pub const OWNED_EXE_NAMES: &[&str] = &["Clippity.exe", "clippity-maintenance.exe"];

/// How long to let terminated processes release their handles before the
/// caller retries the file operation. `TerminateProcess` returns before the
/// kernel finishes tearing the process down.
const SETTLE: Duration = Duration::from_millis(300);

/// The outcome of trying to clear the locks on a set of files.
#[derive(Debug, Default, Clone)]
pub struct LockClearReport {
    /// pids of Clippity-owned processes that were stopped.
    pub terminated: Vec<u32>,
    /// Display names of unrelated / system applications the user must close
    /// — never stopped by the engine.
    pub blocking_apps: Vec<String>,
    /// True when the running maintenance image itself is among the holders
    /// (it cannot stop itself; reboot-scheduled removal handles it).
    pub self_locked: bool,
}

impl LockClearReport {
    /// Whether finishing cleanly needs the user to close a blocking app.
    pub fn user_must_close_apps(&self) -> bool {
        !self.blocking_apps.is_empty()
    }
}

/// Enumerate who holds `targets` open, stop the Clippity-owned holders, and
/// report anything the engine will not close.
///
/// `install_root` / `maintenance_root` come from the installation manifest
/// and bound what counts as "ours". Enumeration failures degrade to an
/// empty report and a warning — the operation then proceeds and relies on
/// the locked-file reboot fallback, never a false success.
pub fn clear_locks(targets: &[&Path], install_root: &str, maintenance_root: &str) -> LockClearReport {
    let mut report = LockClearReport::default();
    if targets.is_empty() {
        return report;
    }

    let locks = match windows_ops::enumerate_lockers(targets) {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!(error = %e, "could not enumerate file locks; proceeding without clearing");
            return report;
        }
    };
    if locks.is_empty() {
        return report;
    }

    let plan = ShutdownPlan::from_locks(&locks, install_root, maintenance_root, OWNED_EXE_NAMES);
    report.self_locked = plan.self_locked;

    for p in &plan.terminable {
        tracing::info!(
            pid = p.pid,
            name = %p.app_name,
            "stopping Clippity-owned process to release a file lock"
        );
        match windows_ops::terminate_process(p.pid) {
            Ok(()) => report.terminated.push(p.pid),
            Err(e) => tracing::warn!(pid = p.pid, error = %e, "could not stop Clippity process"),
        }
    }
    if !report.terminated.is_empty() {
        std::thread::sleep(SETTLE);
    }

    if plan.requires_user_action() {
        report.blocking_apps = plan.blocking_app_names();
        tracing::warn!(
            apps = ?report.blocking_apps,
            "target files are held by applications the engine will not close — a reboot may be required to finish"
        );
    }

    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A file that nothing has open must report no locks and no blockers —
    /// on any platform (off-Windows the enumerator is an empty no-op; on
    /// Windows Restart Manager finds no holders of an unopened temp file).
    #[test]
    fn unlocked_file_yields_empty_report() {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("clippity-shutdown-test-{n}.dat"));
        std::fs::write(&path, b"x").unwrap();

        let report = clear_locks(
            &[path.as_path()],
            r"C:\Program Files\Clippity",
            r"C:\ProgramData\Clippity\maintenance",
        );

        assert!(report.terminated.is_empty());
        assert!(!report.user_must_close_apps());
        assert!(!report.self_locked);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn no_targets_is_a_clear_report() {
        let report = clear_locks(&[], "", "");
        assert!(report.terminated.is_empty());
        assert!(!report.user_must_close_apps());
    }
}
