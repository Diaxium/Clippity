//! Plain-data types that cross the platform facade boundary.
//!
//! These describe *what* to register without any Win32 dependency, so
//! they compile on every target and the services layer can build them
//! directly. The [`UninstallEntry`] mirrors the value set Microsoft
//! documents for the Uninstall registry key, so Clippity shows up in
//! Settings › Apps with a working Uninstall (and Modify) button.

use installer_domain::install::InstallScope;
use installer_domain::state::RegistryHive;
use installer_domain::wizard::ProductInfo;
use installer_infra::paths::InstallerPaths;

/// The uninstall key's subpath under the chosen root hive. The product
/// name is the subkey — stable, and distinct from an MSI ProductCode GUID
/// so the two never collide.
pub const UNINSTALL_SUBKEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Clippity";

/// The `Run` key that drives start-at-login for the current user. Always
/// per-user: start-at-login is a user preference, never machine policy.
pub const RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// The value name written under [`RUN_SUBKEY`].
pub const RUN_VALUE: &str = "Clippity";

/// The registry value set Windows expects for an Add/Remove Programs
/// entry. Field names map to the documented `REG_SZ`/`REG_DWORD` values.
#[derive(Debug, Clone)]
pub struct UninstallEntry {
    /// Which hive to write under, derived from the install scope.
    pub hive: RegistryHive,
    pub display_name: String,
    pub display_version: String,
    pub publisher: String,
    /// `"path,index"` — the installed exe, so Settings shows our icon.
    pub display_icon: String,
    pub install_location: String,
    /// `YYYYMMDD`, the format Windows Installer uses for `InstallDate`.
    pub install_date: String,
    /// Full uninstall command (quoted exe + `--uninstall`).
    pub uninstall_string: String,
    /// Silent uninstall command (adds `--silent`).
    pub quiet_uninstall_string: String,
    /// Command that opens the wizard's Modify flow.
    pub modify_path: String,
    pub url_info_about: String,
    pub help_link: String,
    /// `EstimatedSize` is a DWORD in KiB.
    pub estimated_size_kib: u32,
}

impl UninstallEntry {
    /// Build the entry from the resolved product + install paths.
    ///
    /// `maintenance_exe` is the absolute path of the wizard copy placed in
    /// the maintenance directory — the binary Windows runs for
    /// Uninstall/Modify. It must exist before the entry is written, or the
    /// buttons in Settings would fail.
    pub fn build(
        product: &ProductInfo,
        paths: &InstallerPaths,
        scope: InstallScope,
        maintenance_exe: &str,
        primary_exe: &str,
        install_date: String,
        installed_bytes: u64,
    ) -> Self {
        let install_location = paths.install_dir.display().to_string();
        let quoted = format!("\"{maintenance_exe}\"");
        Self {
            hive: RegistryHive::for_scope(scope),
            display_name: product.name.clone(),
            display_version: product.version.clone(),
            publisher: product.publisher.clone(),
            display_icon: format!("{primary_exe},0"),
            install_location,
            install_date,
            uninstall_string: format!("{quoted} --uninstall"),
            quiet_uninstall_string: format!("{quoted} --uninstall --silent"),
            modify_path: format!("{quoted} --modify"),
            url_info_about: "https://clippity.app".to_string(),
            help_link: "https://clippity.app/help".to_string(),
            estimated_size_kib: (installed_bytes / 1024) as u32,
        }
    }
}
