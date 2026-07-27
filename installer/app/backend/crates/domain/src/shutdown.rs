//! Which processes lock the files a maintenance operation must change, and
//! what the engine is allowed to do about each of them.
//!
//! Windows **Restart Manager** answers the first half — it enumerates the
//! processes holding a file open. The rules for *what to do* are the pure,
//! testable half and live here: a process is only ever force-terminated when
//! it is unambiguously Clippity's own; a critical/system process or Explorer
//! is never touched; and any *unrelated* user application holding one of our
//! files is surfaced for the user to close rather than killed. That encodes
//! the task's hard safety line — "do not kill unrelated applications without
//! permission, do not force Explorer to close unless absolutely necessary".
//!
//! The services layer resolves the raw facts (pid, image path, Restart
//! Manager application type) via `installer-platform`; this module turns a
//! list of those facts into a [`ShutdownPlan`] the caller acts on.

use serde::{Deserialize, Serialize};

/// Restart Manager's classification of an application holding a resource,
/// mapped from `RM_APP_TYPE`. Only the distinctions that change our policy
/// are kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RmAppKind {
    /// A GUI application with a main window (`RmMainWindow`).
    MainWindow,
    /// A GUI application with only secondary windows (`RmOtherWindow`).
    OtherWindow,
    /// A Windows service (`RmService`).
    Service,
    /// Windows Explorer (`RmExplorer`) — never force-closed by us.
    Explorer,
    /// A console application (`RmConsole`).
    Console,
    /// A process the OS deems critical (`RmCritical`) — never touched.
    Critical,
    /// Anything Restart Manager could not type (`RmUnknownApp`).
    Unknown,
}

impl RmAppKind {
    /// Map a raw `RM_APP_TYPE` integer to a kind. Unknown values fall back
    /// to [`RmAppKind::Unknown`] rather than panicking on a future variant.
    pub fn from_raw(raw: i32) -> Self {
        match raw {
            1 => RmAppKind::MainWindow,
            2 => RmAppKind::OtherWindow,
            3 => RmAppKind::Service,
            4 => RmAppKind::Explorer,
            5 => RmAppKind::Console,
            1000 => RmAppKind::Critical,
            _ => RmAppKind::Unknown,
        }
    }
}

/// How a locking process relates to Clippity — the decision that gates
/// whether the engine may stop it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessOwnership {
    /// A Clippity process: its image lives under our install or maintenance
    /// root, or it is one of our known executables. May be asked to stop
    /// and, as a controlled fallback, force-terminated.
    ClippityOwned,
    /// Explorer or an OS-critical process. Never force-closed automatically,
    /// even if it holds one of our files (e.g. a shell integration).
    SystemCritical,
    /// Any other user application holding one of our files. Must be surfaced
    /// for the user to close — never terminated without consent.
    Unrelated,
}

/// One process Restart Manager reported as holding a resource we must
/// change, with the facts needed to classify it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockingProcess {
    /// OS process id.
    pub pid: u32,
    /// The friendly application name Restart Manager reported (window title
    /// or image name) — used for display and as a last-resort match.
    pub app_name: String,
    /// The full image path, when it could be resolved. `None` when the
    /// process could not be opened (e.g. a more-privileged process); the
    /// classifier then falls back to name + kind.
    pub exe_path: Option<String>,
    /// Restart Manager's application type.
    pub kind: RmAppKind,
    /// True when this is the maintenance process itself (it holds its own
    /// image open). Cannot be terminated — it is handled by reboot-scheduled
    /// self-removal or the cleanup worker instead.
    pub is_self: bool,
}

impl LockingProcess {
    /// Classify this process against the recorded Clippity roots and the set
    /// of executables the product is known to ship.
    ///
    /// Roots are matched by directory containment (not raw string prefix) so
    /// a sibling like `…\Clippity Backup` is never mistaken for a child of
    /// `…\Clippity`. Explorer and critical processes are pinned to
    /// [`ProcessOwnership::SystemCritical`] *before* any ownership match, so
    /// a shell extension loaded into Explorer can never be force-terminated.
    pub fn classify(
        &self,
        install_root: &str,
        maintenance_root: &str,
        owned_exe_names: &[&str],
    ) -> ProcessOwnership {
        // Explorer / critical are off-limits regardless of where their image
        // sits — killing them is the "force Explorer to close" case the task
        // forbids except as an absolute last resort (which is not automated).
        if matches!(self.kind, RmAppKind::Explorer | RmAppKind::Critical) {
            return ProcessOwnership::SystemCritical;
        }

        // The running maintenance exe is ours by definition.
        if self.is_self {
            return ProcessOwnership::ClippityOwned;
        }

        // Owned when the image lives under a Clippity root…
        if let Some(path) = &self.exe_path {
            if path_is_within(path, install_root) || path_is_within(path, maintenance_root) {
                return ProcessOwnership::ClippityOwned;
            }
            // …or its file name is a product executable, even from an
            // unexpected location (a stray copy is still ours to stop).
            if let Some(name) = file_name_of(path) {
                if owned_exe_names.iter().any(|o| o.eq_ignore_ascii_case(&name)) {
                    return ProcessOwnership::ClippityOwned;
                }
            }
        } else {
            // No path (could not open the process): fall back to the friendly
            // name only when it is an *exact* product exe name — a fuzzy
            // window-title match must not license a termination.
            if owned_exe_names
                .iter()
                .any(|o| o.eq_ignore_ascii_case(self.app_name.trim()))
            {
                return ProcessOwnership::ClippityOwned;
            }
        }

        ProcessOwnership::Unrelated
    }
}

/// The engine's decision for a set of locking processes: which it may stop,
/// which block on the user, and whether its own image is among them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownPlan {
    /// Clippity-owned processes (excluding this one) that may be asked to
    /// stop and, failing that, terminated to release a lock.
    pub terminable: Vec<LockingProcess>,
    /// True when the running maintenance process itself holds a target file
    /// — it cannot terminate itself; reboot-scheduled removal handles it.
    pub self_locked: bool,
    /// Unrelated user applications holding a target file. Surfaced to the
    /// user to close; never terminated by the engine.
    pub unrelated: Vec<LockingProcess>,
    /// Explorer / critical processes holding a target file. Never touched;
    /// their presence forces a reboot-based fallback.
    pub system_critical: Vec<LockingProcess>,
}

impl ShutdownPlan {
    /// Build a plan from the enumerated locks and the recorded roots.
    pub fn from_locks(
        locks: &[LockingProcess],
        install_root: &str,
        maintenance_root: &str,
        owned_exe_names: &[&str],
    ) -> Self {
        let mut plan = ShutdownPlan::default();
        for p in locks {
            match p.classify(install_root, maintenance_root, owned_exe_names) {
                ProcessOwnership::ClippityOwned => {
                    if p.is_self {
                        plan.self_locked = true;
                    } else {
                        plan.terminable.push(p.clone());
                    }
                }
                ProcessOwnership::Unrelated => plan.unrelated.push(p.clone()),
                ProcessOwnership::SystemCritical => plan.system_critical.push(p.clone()),
            }
        }
        plan
    }

    /// Whether finishing the operation needs the user to act (close a
    /// blocking app) or a reboot (a critical process holds a file). When
    /// true, the engine must not claim an unqualified success.
    pub fn requires_user_action(&self) -> bool {
        !self.unrelated.is_empty() || !self.system_critical.is_empty()
    }

    /// Whether the operation can clear every lock on its own — nothing but
    /// Clippity-owned processes (and possibly our own image) are involved.
    pub fn can_proceed_automatically(&self) -> bool {
        !self.requires_user_action()
    }

    /// Display names of the applications the user must close, for a UI
    /// prompt or a log line.
    pub fn blocking_app_names(&self) -> Vec<String> {
        self.unrelated
            .iter()
            .chain(self.system_critical.iter())
            .map(|p| p.app_name.clone())
            .collect()
    }
}

/// The file-name portion of a path, lowercased for comparison. Handles both
/// `\` and `/` separators.
fn file_name_of(path: &str) -> Option<String> {
    path.rsplit(['\\', '/']).next().and_then(|s| {
        let s = s.trim();
        if s.is_empty() {
            None
        } else {
            Some(s.to_ascii_lowercase())
        }
    })
}

/// Whether `path` sits inside directory `root`, by path-component
/// containment rather than raw string prefix.
///
/// Both sides are lowercased and their separators normalised to `\`; a
/// trailing separator on `root` is ignored. `path` is inside `root` when it
/// equals `root` or begins with `root\`. That separator guard is what stops
/// `C:\p\Clippity Backup\x.exe` being read as inside `C:\p\Clippity`. Paths
/// from `QueryFullProcessImageNameW` are already canonical (no `..`), so no
/// further normalisation is required.
pub fn path_is_within(path: &str, root: &str) -> bool {
    let norm = |s: &str| {
        s.trim()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    let path = norm(path);
    let root = norm(root);
    if root.is_empty() || path.is_empty() {
        return false;
    }
    path == root || path.starts_with(&format!("{root}\\"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const INSTALL: &str = r"C:\Program Files\Clippity";
    const MAINT: &str = r"C:\ProgramData\Clippity\maintenance";
    const OWNED: &[&str] = &["Clippity.exe", "clippity-maintenance.exe"];

    fn proc(pid: u32, name: &str, path: Option<&str>, kind: RmAppKind, is_self: bool) -> LockingProcess {
        LockingProcess {
            pid,
            app_name: name.to_string(),
            exe_path: path.map(str::to_string),
            kind,
            is_self,
        }
    }

    #[test]
    fn path_containment_uses_components_not_prefix() {
        assert!(path_is_within(r"C:\Program Files\Clippity\Clippity.exe", INSTALL));
        assert!(path_is_within(r"C:\Program Files\Clippity\sub\worker.exe", INSTALL));
        assert!(path_is_within(INSTALL, INSTALL)); // the dir itself
        // A sibling that merely shares the name prefix is NOT inside.
        assert!(!path_is_within(r"C:\Program Files\Clippity Backup\x.exe", INSTALL));
        assert!(!path_is_within(r"C:\Windows\explorer.exe", INSTALL));
        // Separator/case-insensitive and forward-slash tolerant.
        assert!(path_is_within(r"c:/program files/clippity/clippity.exe", INSTALL));
        assert!(!path_is_within("", INSTALL));
        assert!(!path_is_within(r"C:\x.exe", ""));
    }

    #[test]
    fn explorer_is_never_owned_even_under_our_root() {
        // A shell extension loaded into Explorer, imaged from our dir, must
        // still be SystemCritical — never a termination target.
        let p = proc(
            10,
            "Windows Explorer",
            Some(r"C:\Program Files\Clippity\shellext-host.exe"),
            RmAppKind::Explorer,
            false,
        );
        assert_eq!(p.classify(INSTALL, MAINT, OWNED), ProcessOwnership::SystemCritical);
    }

    #[test]
    fn critical_is_never_owned() {
        let p = proc(4, "csrss", Some(r"C:\Windows\System32\csrss.exe"), RmAppKind::Critical, false);
        assert_eq!(p.classify(INSTALL, MAINT, OWNED), ProcessOwnership::SystemCritical);
    }

    #[test]
    fn self_is_owned() {
        let p = proc(
            200,
            "clippity-maintenance",
            Some(r"C:\ProgramData\Clippity\maintenance\clippity-maintenance.exe"),
            RmAppKind::MainWindow,
            true,
        );
        assert_eq!(p.classify(INSTALL, MAINT, OWNED), ProcessOwnership::ClippityOwned);
    }

    #[test]
    fn app_under_install_root_is_owned() {
        let p = proc(
            300,
            "Clippity",
            Some(r"C:\Program Files\Clippity\Clippity.exe"),
            RmAppKind::MainWindow,
            false,
        );
        assert_eq!(p.classify(INSTALL, MAINT, OWNED), ProcessOwnership::ClippityOwned);
    }

    #[test]
    fn owned_by_name_from_stray_location() {
        // A copy of our exe running from the temp dir is still ours to stop.
        let p = proc(
            301,
            "Clippity",
            Some(r"C:\Users\x\AppData\Local\Temp\Clippity.exe"),
            RmAppKind::MainWindow,
            false,
        );
        assert_eq!(p.classify(INSTALL, MAINT, OWNED), ProcessOwnership::ClippityOwned);
    }

    #[test]
    fn unknown_path_owned_only_on_exact_name() {
        // No path could be resolved; the exact product name licenses owned…
        let named = proc(400, "Clippity.exe", None, RmAppKind::MainWindow, false);
        assert_eq!(named.classify(INSTALL, MAINT, OWNED), ProcessOwnership::ClippityOwned);
        // …but a fuzzy title does not.
        let titled = proc(401, "Clippity - editing capture.png", None, RmAppKind::MainWindow, false);
        assert_eq!(titled.classify(INSTALL, MAINT, OWNED), ProcessOwnership::Unrelated);
    }

    #[test]
    fn unrelated_user_app_is_unrelated() {
        let p = proc(
            500,
            "Notepad",
            Some(r"C:\Windows\System32\notepad.exe"),
            RmAppKind::MainWindow,
            false,
        );
        assert_eq!(p.classify(INSTALL, MAINT, OWNED), ProcessOwnership::Unrelated);
    }

    #[test]
    fn plan_buckets_and_gates_correctly() {
        let locks = vec![
            proc(1, "Clippity", Some(r"C:\Program Files\Clippity\Clippity.exe"), RmAppKind::MainWindow, false),
            proc(2, "clippity-maintenance", Some(r"C:\ProgramData\Clippity\maintenance\clippity-maintenance.exe"), RmAppKind::MainWindow, true),
            proc(3, "Notepad", Some(r"C:\Windows\System32\notepad.exe"), RmAppKind::MainWindow, false),
            proc(4, "Windows Explorer", Some(r"C:\Windows\explorer.exe"), RmAppKind::Explorer, false),
        ];
        let plan = ShutdownPlan::from_locks(&locks, INSTALL, MAINT, OWNED);

        assert_eq!(plan.terminable.len(), 1);
        assert_eq!(plan.terminable[0].pid, 1);
        assert!(plan.self_locked);
        assert_eq!(plan.unrelated.len(), 1);
        assert_eq!(plan.system_critical.len(), 1);
        assert!(plan.requires_user_action());
        assert!(!plan.can_proceed_automatically());
        assert_eq!(plan.blocking_app_names(), vec!["Notepad".to_string(), "Windows Explorer".to_string()]);
    }

    #[test]
    fn plan_with_only_owned_can_proceed() {
        let locks = vec![
            proc(1, "Clippity", Some(r"C:\Program Files\Clippity\Clippity.exe"), RmAppKind::MainWindow, false),
            proc(2, "clippity-maintenance", None, RmAppKind::MainWindow, true),
        ];
        let plan = ShutdownPlan::from_locks(&locks, INSTALL, MAINT, OWNED);
        assert_eq!(plan.terminable.len(), 1);
        assert!(plan.self_locked);
        assert!(plan.can_proceed_automatically());
        assert!(!plan.requires_user_action());
        assert!(plan.blocking_app_names().is_empty());
    }

    #[test]
    fn empty_locks_is_a_clear_plan() {
        let plan = ShutdownPlan::from_locks(&[], INSTALL, MAINT, OWNED);
        assert!(plan.can_proceed_automatically());
        assert!(!plan.self_locked);
        assert!(plan.terminable.is_empty());
    }

    #[test]
    fn app_kind_from_raw_maps_known_and_unknown() {
        assert_eq!(RmAppKind::from_raw(1), RmAppKind::MainWindow);
        assert_eq!(RmAppKind::from_raw(4), RmAppKind::Explorer);
        assert_eq!(RmAppKind::from_raw(1000), RmAppKind::Critical);
        assert_eq!(RmAppKind::from_raw(999), RmAppKind::Unknown);
        assert_eq!(RmAppKind::from_raw(-1), RmAppKind::Unknown);
    }
}
