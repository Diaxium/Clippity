//! The authoritative on-disk installation model, plus the detection
//! state machine that reasons over it.
//!
//! This is the single source of truth the whole maintenance engine reads:
//! install writes it, detect/modify/repair/uninstall read it. It records
//! *what Clippity put on this machine* — the files it owns, the registry
//! values it wrote, the shortcuts it created, the scope it installed under
//! — so a later operation can reverse exactly those actions and nothing
//! else. Everything here is pure data + pure rules; the services layer
//! performs the I/O that produces and consumes it.
//!
//! The shape is deliberately MSI-adjacent (components, files, registry,
//! shortcuts, a stable installation id) so the documented Option-C target
//! — a WiX-authored MSI driven by this wizard as a bootstrapper — can
//! adopt or supersede a manifest-recorded install deterministically. See
//! `docs/installer/03-installation-model.md`.

use serde::{Deserialize, Serialize};

use crate::install::InstallScope;

/// Bump when the on-disk manifest shape changes incompatibly. A reader
/// that finds a higher `schema_version` than it understands must refuse to
/// act on it (and route the user to a newer wizard) rather than guess.
pub const SCHEMA_VERSION: u32 = 1;

/// Stable product identifier, independent of version or install location.
pub const PRODUCT_ID: &str = "com.clippity.app";

/// Which Windows hive a registry record lives under. Mirrors the install
/// scope so uninstall removes from the same hive it wrote to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RegistryHive {
    /// `HKEY_CURRENT_USER` — per-user installs.
    CurrentUser,
    /// `HKEY_LOCAL_MACHINE` — per-machine installs.
    LocalMachine,
}

impl RegistryHive {
    /// The hive an install of `scope` writes its registrations under.
    pub fn for_scope(scope: InstallScope) -> Self {
        match scope {
            InstallScope::CurrentUser => RegistryHive::CurrentUser,
            InstallScope::AllUsers => RegistryHive::LocalMachine,
        }
    }
}

/// One file the installer placed and therefore owns. `sha256` lets repair
/// detect corruption; `mutable` marks files the app rewrites at runtime
/// (so repair does not fight the app over them).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledFile {
    /// Absolute path on disk.
    pub path: String,
    /// Expected SHA-256 (lowercase hex) of an immutable file; `None` for
    /// files whose contents the app legitimately changes.
    pub sha256: Option<String>,
    /// Size in bytes at install time.
    pub bytes: u64,
    /// Component id that owns this file (`core`, `gif`, …).
    pub component: String,
    /// True when the app rewrites this file at runtime — excluded from
    /// corruption checks.
    pub mutable: bool,
}

/// A registry value the installer wrote, recorded so uninstall/modify can
/// remove exactly it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryRecord {
    pub hive: RegistryHive,
    /// Subkey path under the hive (no hive prefix).
    pub subkey: String,
    /// The value name written, or `None` when the whole subkey is ours to
    /// delete (e.g. the Add/Remove Programs key).
    pub value_name: Option<String>,
}

/// A shortcut (`.lnk`) the installer created.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutRecord {
    /// Absolute path of the `.lnk` file.
    pub path: String,
    /// The executable it points at (for verification during repair).
    pub target: String,
}

/// The authoritative installation manifest, serialized to
/// `install-state.json` in the maintenance directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationManifest {
    pub schema_version: u32,
    pub product_id: String,
    /// Stable per-installation id, generated once at first install.
    pub installation_id: String,
    /// Version of the application this manifest describes.
    pub version: String,
    pub architecture: String,
    pub scope: InstallScope,
    pub install_directory: String,
    pub maintenance_directory: String,
    /// ISO-8601 UTC timestamp of the install/last-repair.
    pub install_date: String,
    /// Component ids that were installed.
    pub installed_components: Vec<String>,
    pub files: Vec<InstalledFile>,
    /// Directories the installer created, deepest-last, for empty-only
    /// removal.
    pub directories: Vec<String>,
    pub registry_entries: Vec<RegistryRecord>,
    pub shortcuts: Vec<ShortcutRecord>,
    /// True when a `Run`-key start-at-login value was written.
    pub start_at_login: bool,
    /// The Options-step choices that left no other trace on the machine.
    ///
    /// Additive and `#[serde(default)]`, so a manifest written before this
    /// field existed still reads (as the shipped defaults, which is what
    /// those installs chose) — no schema bump needed. Recorded because
    /// Modify has to pre-fill them and the application has to honor them;
    /// see [`crate::provisioning`].
    #[serde(default)]
    pub preferences: crate::install::InstallPreferences,
}

impl InstallationManifest {
    /// The installed application executable's absolute path (the file the
    /// `core` component owns and that shortcuts point at). `None` if no
    /// core file is recorded — itself a sign of a broken manifest.
    pub fn primary_exe(&self) -> Option<&str> {
        self.files
            .iter()
            .find(|f| f.component == "core" && f.path.to_lowercase().ends_with(".exe"))
            .map(|f| f.path.as_str())
    }

    /// Reconstruct the Options-step selections this installation was made
    /// with, so Modify opens showing what is actually installed.
    ///
    /// Without this the Modify step opens on `InstallOptions::default()` —
    /// which would silently *change* the user's choices the moment they
    /// pressed "Apply changes", since the modify path rewrites the manifest
    /// and the application's configuration from whatever the wizard holds.
    pub fn installed_options(&self) -> crate::install::InstallOptions {
        crate::install::InstallOptions {
            destination: self.install_directory.clone(),
            create_desktop_shortcut: self.has_desktop_shortcut(),
            start_at_login: self.start_at_login,
            automatic_updates: self.preferences.automatic_updates,
            help_improve: self.preferences.help_improve,
            scope: self.scope,
            file_associations: self.preferences.file_associations,
        }
    }

    /// Whether a desktop shortcut is part of this installation.
    ///
    /// Nothing records the Options-step toggle itself, because the `.lnk`
    /// on the Desktop *is* the record — which is also what lets a repair
    /// restore it. Both `FOLDERID_Desktop` and `FOLDERID_PublicDesktop`
    /// resolve to a folder named `Desktop`, while the Start-menu shortcut
    /// every install writes lands under `Programs`, so the parent folder's
    /// name separates them. Matched case-insensitively: the recorded path
    /// is whatever casing the shell handed back.
    pub fn has_desktop_shortcut(&self) -> bool {
        self.shortcuts.iter().any(|s| {
            std::path::Path::new(&s.path)
                .parent()
                .and_then(|p| p.file_name())
                .is_some_and(|name| name.eq_ignore_ascii_case("Desktop"))
        })
    }

    /// Whether *removing* this installation needs administrator rights.
    ///
    /// Two independent triggers, mirroring the install-side rule: an
    /// all-users install wrote the machine-wide registry hive (removing it
    /// needs elevation), and a protected install or maintenance directory
    /// cannot be deleted by a standard user. Without this check an install
    /// into `C:\Program Files` uninstalls "successfully" while silently
    /// leaving every file behind — even the reboot-scheduled fallback
    /// (`MoveFileEx`) is denied there without an elevated token.
    pub fn needs_elevation_to_remove(&self) -> bool {
        matches!(self.scope, InstallScope::AllUsers)
            || crate::install::path_requires_elevation(&self.install_directory)
            || crate::install::path_requires_elevation(&self.maintenance_directory)
    }

    /// The install date as `YYYYMMDD` (the `InstallDate` registry format),
    /// derived from the stored ISO-8601 `install_date` by keeping the digits
    /// of its date portion. Used when repair rewrites the Add/Remove
    /// Programs entry so it carries the *original* install date, not today's.
    pub fn install_date_yyyymmdd(&self) -> String {
        let date_part = self.install_date.split('T').next().unwrap_or("");
        let digits: String = date_part.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.len() == 8 {
            digits
        } else {
            // An unparseable stored date falls back to empty, which Windows
            // tolerates on the entry rather than showing a wrong date.
            String::new()
        }
    }
}

/// The health of an install as resolved by [`assess`]. Sources that
/// disagree resolve to a recovery-oriented state rather than a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallState {
    /// No trace of Clippity — offer a fresh install.
    NotInstalled,
    /// Manifest, registry, and the on-disk exe all agree and match this
    /// build's version. Offer modify / repair / uninstall.
    Healthy,
    /// Recorded, but files or registrations are missing/corrupt. Offer
    /// repair.
    Damaged,
    /// A manifest or registry entry exists but its counterpart is missing
    /// — an interrupted install/uninstall. Route to recovery.
    Partial,
    /// Installed, but an older version than this wizard carries. Offer
    /// update/reinstall.
    OlderVersion,
    /// Installed at the same version this wizard carries. Offer repair /
    /// reinstall.
    SameVersion,
    /// Installed at a newer version than this wizard carries. Refuse to
    /// downgrade silently.
    NewerVersion,
    /// A registry entry from a mechanism this wizard does not own (e.g. an
    /// MSI/NSIS legacy install) with no manifest. Route to migration.
    LegacyUnmanaged,
}

/// The raw signals the services layer gathers from disk and registry,
/// handed to [`assess`] so the decision itself stays pure and testable.
#[derive(Debug, Clone, Default)]
pub struct DetectionInputs {
    /// A readable, schema-compatible manifest was found.
    pub manifest_present: bool,
    /// The manifest's recorded primary exe exists on disk.
    pub exe_present: bool,
    /// An Add/Remove Programs entry we recognise exists.
    pub registry_present: bool,
    /// The registry entry looks like ours (has our manifest) vs a legacy
    /// unmanaged one.
    pub registry_is_ours: bool,
    /// Version recorded by the manifest, if present.
    pub installed_version: Option<String>,
    /// Version this wizard's payload carries.
    pub wizard_version: String,
    /// The manifest's schema version was readable but too new to trust.
    pub schema_too_new: bool,
}

/// Resolve an [`InstallState`] from gathered signals.
///
/// The ordering encodes the "when sources disagree, prefer recovery" rule:
/// a schema we cannot read, or a manifest/registry mismatch, wins over any
/// happy-path classification.
pub fn assess(inputs: &DetectionInputs) -> InstallState {
    // A manifest too new to understand is a partial/recovery signal, never
    // a healthy one — acting on a shape we do not grasp is how data gets
    // corrupted.
    if inputs.schema_too_new {
        return InstallState::Partial;
    }

    match (inputs.manifest_present, inputs.registry_present) {
        // Nothing recorded and nothing registered: either truly absent, or
        // a foreign (legacy) registration we should route to migration.
        (false, false) => InstallState::NotInstalled,
        (false, true) => {
            if inputs.registry_is_ours {
                // Registered as ours but no manifest — an interrupted
                // install or a half-finished uninstall.
                InstallState::Partial
            } else {
                InstallState::LegacyUnmanaged
            }
        }
        // A manifest but no registry entry is a half state too.
        (true, false) => InstallState::Partial,
        (true, true) => {
            if !inputs.exe_present {
                return InstallState::Damaged;
            }
            match &inputs.installed_version {
                None => InstallState::Damaged,
                Some(v) => match crate::update::compare_versions(v, &inputs.wizard_version) {
                    std::cmp::Ordering::Less => InstallState::OlderVersion,
                    std::cmp::Ordering::Equal => InstallState::SameVersion,
                    std::cmp::Ordering::Greater => InstallState::NewerVersion,
                },
            }
        }
    }
}

/// A detection result carrying the resolved state plus the facts behind
/// it, for display on the maintenance hub and the logs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub state: InstallState,
    pub installed_version: Option<String>,
    pub install_directory: Option<String>,
    pub scope: Option<InstallScope>,
    pub installation_id: Option<String>,
}

impl Detection {
    /// A "nothing here" detection — the fresh-install starting point.
    pub fn not_installed() -> Self {
        Self {
            state: InstallState::NotInstalled,
            installed_version: None,
            install_directory: None,
            scope: None,
            installation_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> DetectionInputs {
        DetectionInputs {
            wizard_version: "1.5.0".into(),
            ..Default::default()
        }
    }

    #[test]
    fn nothing_present_is_not_installed() {
        assert_eq!(assess(&inputs()), InstallState::NotInstalled);
    }

    #[test]
    fn foreign_registry_without_manifest_is_legacy() {
        let i = DetectionInputs {
            registry_present: true,
            registry_is_ours: false,
            ..inputs()
        };
        assert_eq!(assess(&i), InstallState::LegacyUnmanaged);
    }

    #[test]
    fn our_registry_without_manifest_is_partial() {
        let i = DetectionInputs {
            registry_present: true,
            registry_is_ours: true,
            ..inputs()
        };
        assert_eq!(assess(&i), InstallState::Partial);
    }

    #[test]
    fn manifest_without_exe_is_damaged() {
        let i = DetectionInputs {
            manifest_present: true,
            registry_present: true,
            registry_is_ours: true,
            exe_present: false,
            installed_version: Some("1.5.0".into()),
            ..inputs()
        };
        assert_eq!(assess(&i), InstallState::Damaged);
    }

    #[test]
    fn version_comparison_drives_healthy_states() {
        let base = DetectionInputs {
            manifest_present: true,
            registry_present: true,
            registry_is_ours: true,
            exe_present: true,
            ..inputs()
        };
        assert_eq!(
            assess(&DetectionInputs { installed_version: Some("1.4.0".into()), ..base.clone() }),
            InstallState::OlderVersion
        );
        assert_eq!(
            assess(&DetectionInputs { installed_version: Some("1.5.0".into()), ..base.clone() }),
            InstallState::SameVersion
        );
        assert_eq!(
            assess(&DetectionInputs { installed_version: Some("2.0.0".into()), ..base }),
            InstallState::NewerVersion
        );
    }

    /// A minimal manifest for the elevation-to-remove checks: only the three
    /// fields the rule reads (scope + the two directories) need to be real.
    fn manifest_at(scope: InstallScope, install_dir: &str, maintenance_dir: &str) -> InstallationManifest {
        InstallationManifest {
            schema_version: SCHEMA_VERSION,
            product_id: PRODUCT_ID.to_string(),
            installation_id: "id".into(),
            version: "1.0.0".into(),
            architecture: "x64".into(),
            scope,
            install_directory: install_dir.into(),
            maintenance_directory: maintenance_dir.into(),
            install_date: "1970-01-01T00:00:00Z".into(),
            installed_components: vec![],
            files: vec![],
            directories: vec![],
            registry_entries: vec![],
            shortcuts: vec![],
            start_at_login: false,
            preferences: crate::install::InstallPreferences::default(),
        }
    }

    #[test]
    fn per_user_install_in_writable_dir_removes_without_elevation() {
        let m = manifest_at(
            InstallScope::CurrentUser,
            r"C:\Users\Sam\AppData\Local\Clippity",
            r"C:\Users\Sam\AppData\Local\Clippity\maintenance",
        );
        assert!(!m.needs_elevation_to_remove());
    }

    #[test]
    fn install_in_program_files_needs_elevation_to_remove() {
        let m = manifest_at(
            InstallScope::CurrentUser,
            r"C:\Program Files\Clippity",
            r"C:\Users\Sam\AppData\Local\Clippity\maintenance",
        );
        assert!(m.needs_elevation_to_remove());
    }

    #[test]
    fn installed_options_round_trip_what_the_install_recorded() {
        // Modify opens on these; if any field fell back to a default, the
        // next "Apply changes" would quietly overwrite the user's choice.
        let mut m = manifest_at(
            InstallScope::AllUsers,
            r"D:\Apps\Clippity",
            r"C:\ProgramData\Clippity\maintenance",
        );
        m.start_at_login = true;
        m.preferences = crate::install::InstallPreferences {
            automatic_updates: false,
            help_improve: false,
            file_associations: false,
        };
        m.shortcuts = vec![ShortcutRecord {
            path: r"C:\Users\Public\Desktop\Clippity.lnk".into(),
            target: r"D:\Apps\Clippity\Clippity.exe".into(),
        }];

        let options = m.installed_options();
        assert_eq!(options.destination, r"D:\Apps\Clippity");
        assert_eq!(options.scope, InstallScope::AllUsers);
        assert!(options.create_desktop_shortcut);
        assert!(options.start_at_login);
        assert!(!options.automatic_updates);
        assert!(!options.help_improve);
        assert!(!options.file_associations);
    }

    #[test]
    fn a_manifest_predating_preferences_reads_as_the_shipped_defaults() {
        // Additive field, so no schema bump — but an install made before it
        // existed must not read back as "everything declined".
        let json = r#"{
            "schemaVersion": 1,
            "productId": "com.clippity.app",
            "installationId": "id",
            "version": "1.0.0",
            "architecture": "x64",
            "scope": "current-user",
            "installDirectory": "C:\\Program Files\\Clippity",
            "maintenanceDirectory": "C:\\ProgramData\\Clippity",
            "installDate": "1970-01-01T00:00:00Z",
            "installedComponents": [],
            "files": [],
            "directories": [],
            "registryEntries": [],
            "shortcuts": [],
            "startAtLogin": false
        }"#;
        let m: InstallationManifest = serde_json::from_str(json).expect("older manifest parses");
        assert!(m.preferences.automatic_updates);
        assert!(m.preferences.help_improve);
        assert!(m.preferences.file_associations);
    }

    #[test]
    fn all_users_scope_needs_elevation_to_remove_anywhere() {
        let m = manifest_at(
            InstallScope::AllUsers,
            r"D:\Apps\Clippity",
            r"C:\ProgramData\Clippity\maintenance",
        );
        assert!(m.needs_elevation_to_remove());
    }

    #[test]
    fn unreadable_schema_forces_recovery() {
        let i = DetectionInputs {
            manifest_present: true,
            registry_present: true,
            registry_is_ours: true,
            exe_present: true,
            installed_version: Some("1.5.0".into()),
            schema_too_new: true,
            ..inputs()
        };
        assert_eq!(assess(&i), InstallState::Partial);
    }
}
