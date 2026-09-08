//! The Add/Remove Programs (Apps & features) registry entry, the
//! start-at-login `Run` value, and the detection reads over both.
//!
//! An installed app advertises itself under
//! `HK{CU,LM}\Software\Microsoft\Windows\CurrentVersion\Uninstall\Clippity`.
//! Windows reads the values here to populate Settings › Apps and to run our
//! uninstaller. The value set is [`crate::entry::UninstallEntry`]; this
//! module commits it and reads it back.

use installer_domain::state::{RegistryHive, SCHEMA_VERSION};
use installer_infra::error::InstallerResult;

use crate::entry::{UninstallEntry, RUN_SUBKEY, RUN_VALUE, UNINSTALL_SUBKEY};
use crate::windows::regutil;

/// A private marker value that distinguishes an entry *this wizard* wrote
/// from any foreign `Uninstall\Clippity` key. Its presence means "managed
/// by the Clippity maintenance engine"; its absence on an existing key
/// routes detection to the legacy/migration path instead of a happy one.
pub const MARKER_VALUE: &str = "ClippityInstallerSchema";
pub const FILE_PROG_ID: &str = "Clippity.File";
pub const FILE_EXTENSIONS: &[&str] = &[".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".mp4"];

/// Write (or update) the Add/Remove Programs entry under the hive the
/// scope selected. Idempotent: re-running overwrites the same values.
pub fn write_uninstall_entry(entry: &UninstallEntry) -> InstallerResult<()> {
    tracing::info!(
        hive = ?entry.hive,
        subkey = UNINSTALL_SUBKEY,
        name = %entry.display_name,
        version = %entry.display_version,
        "writing Add/Remove Programs entry"
    );

    let key = regutil::create(entry.hive, UNINSTALL_SUBKEY)?;
    regutil::set_sz(&key, "DisplayName", &entry.display_name)?;
    regutil::set_sz(&key, "DisplayVersion", &entry.display_version)?;
    regutil::set_sz(&key, "Publisher", &entry.publisher)?;
    regutil::set_sz(&key, "DisplayIcon", &entry.display_icon)?;
    regutil::set_sz(&key, "InstallLocation", &entry.install_location)?;
    regutil::set_sz(&key, "InstallDate", &entry.install_date)?;
    regutil::set_sz(&key, "UninstallString", &entry.uninstall_string)?;
    regutil::set_sz(&key, "QuietUninstallString", &entry.quiet_uninstall_string)?;
    regutil::set_sz(&key, "ModifyPath", &entry.modify_path)?;
    regutil::set_sz(&key, "URLInfoAbout", &entry.url_info_about)?;
    regutil::set_sz(&key, "HelpLink", &entry.help_link)?;
    regutil::set_dword(&key, "EstimatedSize", entry.estimated_size_kib)?;
    // The wizard offers Modify and Repair; leave both enabled. We
    // deliberately do NOT set `WindowsInstaller` or `SystemComponent` —
    // this is not an MSI, and claiming so would mislead Windows and hide
    // the entry.
    regutil::set_dword(&key, "NoModify", 0)?;
    regutil::set_dword(&key, "NoRepair", 0)?;
    // Our ownership marker, carrying the schema so a future wizard can
    // reason about compatibility.
    regutil::set_dword(&key, MARKER_VALUE, SCHEMA_VERSION)?;
    Ok(())
}

/// Delete the Add/Remove Programs entry during uninstall. Removing the
/// whole subkey is correct: every value under it is ours.
pub fn remove_uninstall_entry(hive: RegistryHive) -> InstallerResult<()> {
    tracing::info!(
        ?hive,
        subkey = UNINSTALL_SUBKEY,
        "removing Add/Remove Programs entry"
    );
    regutil::delete_tree(hive, UNINSTALL_SUBKEY)
}

/// Enable or disable launching `target_exe` at user login by writing or
/// deleting the [`RUN_VALUE`] under the per-user `Run` key. Start-at-login
/// is always per-user — it is a user preference, never machine policy.
pub fn set_start_at_login(target_exe: &str, enabled: bool) -> InstallerResult<()> {
    let key = regutil::create(RegistryHive::CurrentUser, RUN_SUBKEY)?;
    if enabled {
        tracing::info!(target = target_exe, "enabling start-at-login");
        // Quote the path: user profile paths routinely contain spaces.
        regutil::set_sz(&key, RUN_VALUE, &format!("\"{target_exe}\""))
    } else {
        tracing::info!("disabling start-at-login");
        regutil::delete_value(&key, RUN_VALUE)
    }
}

/// Register Clippity in Windows' Open With list for the media types it can
/// actually route into Editor/Studio. Existing default handlers are never
/// replaced; this writes only our ProgID and OpenWithProgids values.
pub fn set_file_associations(
    hive: RegistryHive,
    target_exe: &str,
    enabled: bool,
) -> InstallerResult<()> {
    let classes = r"Software\Classes";
    let prog_id = format!(r"{classes}\{FILE_PROG_ID}");
    if !enabled {
        for ext in FILE_EXTENSIONS {
            let key = format!(r"{classes}\{ext}\OpenWithProgids");
            let _ = regutil::delete_value_at(hive, &key, FILE_PROG_ID);
        }
        return regutil::delete_tree(hive, &prog_id);
    }

    let root = regutil::create(hive, &prog_id)?;
    regutil::set_sz(&root, "", "Clippity media")?;
    let icon = regutil::create(hive, &format!(r"{prog_id}\DefaultIcon"))?;
    regutil::set_sz(&icon, "", &format!("{target_exe},0"))?;
    let command = regutil::create(hive, &format!(r"{prog_id}\shell\open\command"))?;
    regutil::set_sz(&command, "", &format!(r#""{target_exe}" "%1""#))?;
    for ext in FILE_EXTENSIONS {
        let key = regutil::create(hive, &format!(r"{classes}\{ext}\OpenWithProgids"))?;
        regutil::set_sz(&key, FILE_PROG_ID, "")?;
    }
    tracing::info!(?hive, enabled, "updated file associations");
    Ok(())
}

/// Which hive, if any, carries an `Uninstall\Clippity` key. Machine scope
/// is checked first so an all-users install is preferred over a stray
/// per-user one when both somehow exist.
pub fn uninstall_hive_present() -> Option<RegistryHive> {
    [RegistryHive::LocalMachine, RegistryHive::CurrentUser]
        .into_iter()
        .find(|&hive| regutil::key_exists(hive, UNINSTALL_SUBKEY))
}

/// Whether the entry under `hive` carries our ownership marker.
pub fn uninstall_entry_is_managed(hive: RegistryHive) -> bool {
    regutil::value_exists(hive, UNINSTALL_SUBKEY, MARKER_VALUE)
}
