//! Handing an install off to an elevated copy of the installer.
//!
//! When the chosen destination needs administrator rights, the wizard
//! cannot simply gain them — Windows only grants an elevated token at
//! process start. So the running (unelevated) instance writes the plan
//! the user assembled to a handoff file, relaunches itself under the
//! `runas` verb with `--resume <file>`, and exits. The elevated copy
//! reads the file back and jumps straight to the Installing step, so the
//! user answers the wizard once and the UAC prompt once.
//!
//! A per-user install into a writable folder never comes through here at
//! all; see `installer_domain::install::needs_elevation`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use installer_domain::install::InstallPlan;
use installer_domain::uninstall::RemovalSelection;
use installer_infra::error::{other, InstallerResult};
use installer_platform::windows_ops;

/// Command-line flag naming the install handoff file.
pub const RESUME_FLAG: &str = "--resume";

/// Command-line flag naming the uninstall handoff file.
pub const RESUME_UNINSTALL_FLAG: &str = "--resume-uninstall";

/// Name of the install handoff file inside the temp directory.
const HANDOFF_FILE: &str = "clippity-setup-handoff.json";

/// Name of the uninstall handoff file inside the temp directory.
const UNINSTALL_HANDOFF_FILE: &str = "clippity-uninstall-handoff.json";

/// Write `value` to `file` in the temp directory and return its path.
///
/// The temp directory is the one place both the unelevated and elevated
/// processes can read; the path is passed explicitly on the command line
/// because the two may resolve different `%TEMP%` locations.
fn write_handoff_json<T: Serialize>(file: &str, value: &T, what: &str) -> InstallerResult<PathBuf> {
    let path = std::env::temp_dir().join(file);
    let json =
        serde_json::to_string(value).map_err(|e| other(format!("could not serialize {what}: {e}")))?;
    fs::write(&path, json)?;
    tracing::info!(path = %path.display(), what, "wrote elevation handoff");
    Ok(path)
}

/// Read a value back from a handoff file, deleting it on success.
///
/// The file is removed immediately: it has served its purpose, and leaving
/// a stale handoff in temp would let a later launch resume an operation the
/// user never asked for.
fn read_handoff_json<T: DeserializeOwned>(path: &Path, what: &str) -> InstallerResult<T> {
    let raw = fs::read_to_string(path)?;
    let value: T = serde_json::from_str(&raw)
        .map_err(|e| other(format!("the {what} handed over was unreadable: {e}")))?;
    let _ = fs::remove_file(path);
    Ok(value)
}

/// Extract the path following `flag` in a process argument list, if present.
///
/// Returns `None` for an ordinary launch, which is the common case — the
/// installer is normally started by double-click with no arguments.
fn handoff_path_after<I, S>(args: I, flag: &str) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg.as_ref() == flag {
            return iter.next().map(|p| PathBuf::from(p.as_ref()));
        }
    }
    None
}

/// Write `plan` to the install handoff file and return its absolute path.
pub fn write_handoff(plan: &InstallPlan) -> InstallerResult<PathBuf> {
    write_handoff_json(HANDOFF_FILE, plan, "the install plan")
}

/// Read a plan back from the install handoff file written before elevation.
pub fn read_handoff(path: &Path) -> InstallerResult<InstallPlan> {
    let plan: InstallPlan = read_handoff_json(path, "install plan")?;
    tracing::info!(dest = %plan.options.destination, "resumed plan from handoff");
    Ok(plan)
}

/// Write the handoff and relaunch this installer elevated to execute it.
///
/// On success the caller must close the current window — the elevated
/// copy now owns the install.
pub fn relaunch_with(plan: &InstallPlan) -> InstallerResult<()> {
    let handoff = write_handoff(plan)?;
    let exe = std::env::current_exe()?;
    // Quote the path: temp directories sit under a user profile, and user
    // names routinely contain spaces.
    let args = format!("{RESUME_FLAG} \"{}\"", handoff.display());
    windows_ops::relaunch_elevated(&exe, &args)
}

/// Extract the install handoff path from a process argument list, if present.
pub fn resume_path_from_args<I, S>(args: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    handoff_path_after(args, RESUME_FLAG)
}

/// Write `selection` to the uninstall handoff file and return its path.
pub fn write_uninstall_handoff(selection: &RemovalSelection) -> InstallerResult<PathBuf> {
    write_handoff_json(UNINSTALL_HANDOFF_FILE, selection, "the removal selection")
}

/// Read a removal selection back from the uninstall handoff file.
pub fn read_uninstall_handoff(path: &Path) -> InstallerResult<RemovalSelection> {
    let selection: RemovalSelection = read_handoff_json(path, "removal selection")?;
    tracing::info!(
        remove = selection.remove_ids.len(),
        "resumed removal selection from handoff"
    );
    Ok(selection)
}

/// Write the removal selection and relaunch this installer elevated to run
/// the uninstall. Mirrors [`relaunch_with`] for the removal path: an install
/// into a protected location (or an all-users install) cannot be deleted by
/// an unelevated process, so the uninstall hands itself to an elevated copy
/// exactly as the install does.
///
/// On success the caller must close the current window — the elevated copy
/// now owns the uninstall.
pub fn relaunch_uninstall_with(selection: &RemovalSelection) -> InstallerResult<()> {
    let handoff = write_uninstall_handoff(selection)?;
    let exe = std::env::current_exe()?;
    let args = format!("{RESUME_UNINSTALL_FLAG} \"{}\"", handoff.display());
    windows_ops::relaunch_elevated(&exe, &args)
}

/// Extract the uninstall handoff path from a process argument list.
pub fn resume_uninstall_path_from_args<I, S>(args: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    handoff_path_after(args, RESUME_UNINSTALL_FLAG)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_resume_path() {
        let args = vec!["setup.exe", RESUME_FLAG, r"C:\Temp\handoff.json"];
        assert_eq!(
            resume_path_from_args(args),
            Some(PathBuf::from(r"C:\Temp\handoff.json"))
        );
    }

    #[test]
    fn ordinary_launch_has_no_resume_path() {
        assert_eq!(resume_path_from_args(vec!["setup.exe"]), None);
    }

    #[test]
    fn dangling_flag_is_not_a_path() {
        // `--resume` with nothing after it must not panic or resume.
        assert_eq!(resume_path_from_args(vec!["setup.exe", RESUME_FLAG]), None);
    }

    #[test]
    fn finds_the_uninstall_resume_path() {
        let args = vec!["setup.exe", RESUME_UNINSTALL_FLAG, r"C:\Temp\u.json"];
        assert_eq!(
            resume_uninstall_path_from_args(args),
            Some(PathBuf::from(r"C:\Temp\u.json"))
        );
    }

    #[test]
    fn install_and_uninstall_resume_flags_do_not_cross_match() {
        // An install handoff must not be read as an uninstall one, or vice versa.
        let install = vec!["setup.exe", RESUME_FLAG, r"C:\Temp\i.json"];
        assert_eq!(resume_uninstall_path_from_args(install), None);
        let uninstall = vec!["setup.exe", RESUME_UNINSTALL_FLAG, r"C:\Temp\u.json"];
        assert_eq!(resume_path_from_args(uninstall), None);
    }

    #[test]
    fn uninstall_handoff_round_trips() {
        let selection = RemovalSelection {
            remove_ids: vec!["settings".into(), "cache".into()],
            export_settings: true,
            acknowledged: true,
        };
        let path = write_uninstall_handoff(&selection).unwrap();
        let read = read_uninstall_handoff(&path).unwrap();
        assert_eq!(read.remove_ids, selection.remove_ids);
        assert!(read.export_settings);
        assert!(read.acknowledged);
        // The file is consumed on read.
        assert!(!path.exists());
    }
}
