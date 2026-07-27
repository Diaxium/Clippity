//! The installer → application handoff document.
//!
//! Everything the wizard asks the user is a decision about the *installed
//! application*, but the application has no way to see the wizard: it
//! starts in a different process, days later, and the manifest that records
//! the install is the installer's own private schema in a directory the app
//! has no business locating. So a declined component or a cleared toggle
//! used to evaporate the moment the wizard closed — the app shipped every
//! feature regardless, and "Enable automatic updates" bound to nothing.
//!
//! This module is the contract that closes that gap: a small, versioned
//! JSON document written **beside the installed executable** as
//! [`PROVISIONING_FILE`], which the app finds with nothing but
//! `current_exe()`. It is deliberately not the installation manifest —
//! the manifest is a removal ledger (every file, registry value and
//! shortcut, so uninstall can reverse exactly those), while this is a
//! statement of *what the user asked for*. Keeping them apart means the
//! app never parses a schema it doesn't own, and the ledger can change
//! shape without breaking every installed copy of Clippity.
//!
//! The application mirrors these types in `clippity_domain::provisioning`
//! and treats the whole file as advisory: a missing, unreadable, or
//! newer-schema document means "assume nothing was declined" rather than
//! "disable everything", because a portable build and a developer's
//! `cargo run` have no installer behind them at all.
//!
//! Written on install *and modify* (the same code path), restored by
//! repair, and removed by uninstall along with every other recorded file.

use serde::{Deserialize, Serialize};

use crate::install::InstallScope;
use crate::state::InstallationManifest;

/// File name of the handoff document, written into the install directory
/// next to the application executable.
///
/// The app resolves it as `current_exe().parent().join(…)`, so the name is
/// load-bearing on both sides — change it here and in
/// `clippity_domain::provisioning` together.
pub const PROVISIONING_FILE: &str = "install-config.json";

/// Component id recorded for the handoff document in the manifest's file
/// list.
///
/// Deliberately **not** one of the catalog's selectable components: the
/// document belongs to no feature the user can decline — it is what
/// *records* those declines. Its own id keeps
/// [`crate::repair::RepairAssessment::core_is_broken`] about the executable
/// alone (so a missing document doesn't trigger a needless exe rewrite)
/// while still letting a deleted document light up "Repair recommended" —
/// which matters, because a deleted document silently hands back every
/// feature the user turned off.
pub const PROVISIONING_COMPONENT: &str = "config";

/// Bump only on a shape change the app's reader could misinterpret.
///
/// The app refuses to act on a `schema_version` above the one it knows and
/// falls back to "everything enabled", so a bump degrades gracefully:
/// an older app keeps working with all features rather than guessing at
/// fields it cannot read.
pub const PROVISIONING_SCHEMA_VERSION: u32 = 1;

/// The install-time preferences the application should reflect.
///
/// Distinct from [`InstallPreferences`] because this is the *composed*
/// view: three fields the manifest records in its `preferences` block plus
/// two it records structurally (the `Run` value, the desktop shortcut).
/// The app wants all five in one place and shouldn't have to know which of
/// them left a trace on Windows and which didn't.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionedPreferences {
    /// A desktop shortcut was requested.
    pub desktop_shortcut: bool,
    /// Clippity was registered to start with Windows.
    pub start_at_login: bool,
    /// The user left automatic updates on.
    pub automatic_updates: bool,
    /// The user agreed to share anonymous usage data.
    pub help_improve: bool,
    /// Clippity was registered as a handler for supported file types.
    pub file_associations: bool,
}

/// The handoff document itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppProvisioning {
    pub schema_version: u32,
    /// Stable product id, so a stray file from another product is ignored
    /// rather than acted on.
    pub product_id: String,
    /// Version that was installed — for diagnostics, not for decisions.
    pub version: String,
    /// ISO-8601 UTC timestamp of the install / last modify.
    pub written_at: String,
    pub scope: InstallScope,
    /// Component ids the user kept. The app reads feature availability
    /// from this list — see `clippity_domain::provisioning::Capabilities`.
    pub components: Vec<String>,
    pub preferences: ProvisionedPreferences,
}

impl AppProvisioning {
    /// Compose the document from a committed installation manifest.
    ///
    /// Built from the manifest rather than from the wizard's live options
    /// so install, modify, and repair all produce byte-identical output:
    /// the manifest is what the machine actually ended up in, and a repair
    /// has no wizard selections to read from in the first place.
    pub fn from_manifest(manifest: &InstallationManifest) -> Self {
        Self {
            schema_version: PROVISIONING_SCHEMA_VERSION,
            product_id: manifest.product_id.clone(),
            version: manifest.version.clone(),
            written_at: manifest.install_date.clone(),
            scope: manifest.scope,
            components: manifest.installed_components.clone(),
            preferences: ProvisionedPreferences {
                desktop_shortcut: manifest.has_desktop_shortcut(),
                start_at_login: manifest.start_at_login,
                automatic_updates: manifest.preferences.automatic_updates,
                help_improve: manifest.preferences.help_improve,
                file_associations: manifest.preferences.file_associations,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::InstallPreferences;
    use crate::state::{InstalledFile, ShortcutRecord, PRODUCT_ID, SCHEMA_VERSION};

    fn manifest() -> InstallationManifest {
        InstallationManifest {
            schema_version: SCHEMA_VERSION,
            product_id: PRODUCT_ID.to_string(),
            installation_id: "id".into(),
            version: "1.5.0".into(),
            architecture: "x64".into(),
            scope: InstallScope::CurrentUser,
            install_directory: r"C:\Program Files\Clippity".into(),
            maintenance_directory: r"C:\ProgramData\Clippity\maintenance".into(),
            install_date: "2026-07-25T10:00:00Z".into(),
            installed_components: vec!["core".into(), "capture".into()],
            files: vec![InstalledFile {
                path: r"C:\Program Files\Clippity\Clippity.exe".into(),
                sha256: None,
                bytes: 1,
                component: "core".into(),
                mutable: false,
            }],
            directories: vec![],
            registry_entries: vec![],
            shortcuts: vec![],
            start_at_login: true,
            preferences: InstallPreferences {
                automatic_updates: false,
                help_improve: false,
                file_associations: true,
            },
        }
    }

    #[test]
    fn composes_preferences_from_every_source_the_manifest_has() {
        let doc = AppProvisioning::from_manifest(&manifest());
        assert_eq!(doc.schema_version, PROVISIONING_SCHEMA_VERSION);
        assert_eq!(doc.product_id, PRODUCT_ID);
        assert_eq!(doc.components, vec!["core", "capture"]);
        // The Run-key field, the recorded `preferences` block, and the
        // shortcut list all land in one flat record for the app.
        assert!(doc.preferences.start_at_login);
        assert!(!doc.preferences.automatic_updates);
        assert!(!doc.preferences.help_improve);
        assert!(doc.preferences.file_associations);
        assert!(!doc.preferences.desktop_shortcut, "no shortcuts recorded");
    }

    #[test]
    fn desktop_shortcut_is_derived_from_the_recorded_shortcuts() {
        // Nothing records the toggle itself — a `.lnk` on the Desktop *is*
        // the record, which is also what makes it survive a repair.
        let mut m = manifest();
        m.shortcuts = vec![
            ShortcutRecord {
                path: r"C:\Users\Sam\Desktop\Clippity.lnk".into(),
                target: r"C:\Program Files\Clippity\Clippity.exe".into(),
            },
            ShortcutRecord {
                path: r"C:\Users\Sam\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Clippity.lnk".into(),
                target: r"C:\Program Files\Clippity\Clippity.exe".into(),
            },
        ];
        assert!(AppProvisioning::from_manifest(&m).preferences.desktop_shortcut);
    }

    #[test]
    fn start_menu_only_install_reports_no_desktop_shortcut() {
        // Every install writes a Start-menu shortcut, so a naive
        // "any shortcut" check would report a desktop icon that isn't there.
        let mut m = manifest();
        m.shortcuts = vec![ShortcutRecord {
            path: r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Clippity.lnk".into(),
            target: r"C:\Program Files\Clippity\Clippity.exe".into(),
        }];
        assert!(!AppProvisioning::from_manifest(&m).preferences.desktop_shortcut);
    }

    #[test]
    fn document_serializes_camel_case_for_the_apps_reader() {
        let json = serde_json::to_string(&AppProvisioning::from_manifest(&manifest())).unwrap();
        for key in [
            "\"schemaVersion\"",
            "\"productId\"",
            "\"writtenAt\"",
            "\"components\"",
            "\"desktopShortcut\"",
            "\"startAtLogin\"",
            "\"automaticUpdates\"",
            "\"helpImprove\"",
            "\"fileAssociations\"",
        ] {
            assert!(json.contains(key), "missing {key} in {json}");
        }
        // Scope is kebab-case on the wire, matching every other enum.
        assert!(json.contains("\"current-user\""), "{json}");
    }

    #[test]
    fn document_round_trips() {
        let doc = AppProvisioning::from_manifest(&manifest());
        let back: AppProvisioning = serde_json::from_str(&serde_json::to_string(&doc).unwrap()).unwrap();
        assert_eq!(doc, back);
    }
}
