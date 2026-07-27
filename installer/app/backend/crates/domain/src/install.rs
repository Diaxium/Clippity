//! Install configuration: options, components, and the resolved plan.

use serde::{Deserialize, Serialize};

/// Default install destination shown pre-filled in the Options step.
/// Mirrors `installer_infra::paths::DEFAULT_INSTALL_DIR`; duplicated here
/// as a literal so the domain crate stays I/O- and dependency-free.
pub const DEFAULT_INSTALL_DIR: &str = r"C:\Program Files\Clippity";

/// Who the install targets. `AllUsers` requires elevation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallScope {
    CurrentUser,
    AllUsers,
}

/// Toggleable install-time behaviors (the Options step switches).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    pub destination: String,
    pub create_desktop_shortcut: bool,
    pub start_at_login: bool,
    pub automatic_updates: bool,
    pub help_improve: bool,
    pub scope: InstallScope,
    pub file_associations: bool,
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            destination: DEFAULT_INSTALL_DIR.to_string(),
            create_desktop_shortcut: true,
            start_at_login: false,
            automatic_updates: true,
            help_improve: true,
            scope: InstallScope::CurrentUser,
            file_associations: true,
        }
    }
}

/// The Options-step choices that leave **no other trace on the machine**,
/// and therefore have to be recorded in the installation manifest for
/// anything later to know about them.
///
/// The other three are already recoverable from what the install did:
/// `create_desktop_shortcut` from [`crate::state::InstallationManifest::shortcuts`],
/// `start_at_login` from its own manifest field (uninstall needs it to
/// remove the `Run` value), and `destination`/`scope` from the recorded
/// directories. These three configure the *application*, not Windows, so
/// without this record a Modify run would have nothing to pre-fill and the
/// app would have nothing to honor — see [`crate::provisioning`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPreferences {
    pub automatic_updates: bool,
    pub help_improve: bool,
    pub file_associations: bool,
}

impl Default for InstallPreferences {
    fn default() -> Self {
        // Mirrors `InstallOptions::default` — an older manifest that
        // predates this record reads as "the shipped defaults", which is
        // what those installs actually chose.
        Self {
            automatic_updates: true,
            help_improve: true,
            file_associations: true,
        }
    }
}

impl InstallOptions {
    /// The subset of these options that only the manifest can remember.
    pub fn preferences(&self) -> InstallPreferences {
        InstallPreferences {
            automatic_updates: self.automatic_updates,
            help_improve: self.help_improve,
            file_associations: self.file_associations,
        }
    }
}

/// A selectable feature in the Components step.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    pub name: String,
    pub description: String,
    pub size_bytes: u64,
    pub required: bool,
    pub recommended_default: bool,
}

/// A fully-resolved plan the backend can execute.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub options: InstallOptions,
    pub selected_components: Vec<String>,
    pub component_bytes: u64,
    pub estimated_disk_bytes: u64,
}

/// Overhead multiplier for scratch space, temp extraction, and registry
/// churn on top of the raw component footprint.
const DISK_OVERHEAD_NUMERATOR: u64 = 136; // 1.36x

/// Resolve a plan from the chosen options + component selection.
///
/// `required` components are force-included even if the caller omits
/// them, matching the disabled+checked checkboxes in the UI.
pub fn build_plan(
    options: InstallOptions,
    catalog: &[Component],
    selected_ids: &[String],
) -> InstallPlan {
    let mut ids: Vec<String> = Vec::new();
    let mut component_bytes: u64 = 0;

    for c in catalog {
        let picked = c.required || selected_ids.iter().any(|s| s == &c.id);
        if picked {
            ids.push(c.id.clone());
            component_bytes += c.size_bytes;
        }
    }

    let estimated_disk_bytes = component_bytes * DISK_OVERHEAD_NUMERATOR / 100;

    InstallPlan {
        options,
        selected_components: ids,
        component_bytes,
        estimated_disk_bytes,
    }
}

/// Directory roots a standard user cannot write to. A destination under
/// any of these needs an elevated token before the copy step runs.
///
/// Compared case-insensitively against the destination's prefix, which is
/// what Windows path semantics call for and what the Options step's free-
/// text field makes necessary (the user can type any casing).
const PROTECTED_ROOTS: &[&str] = &[
    r"c:\program files",
    r"c:\program files (x86)",
    r"c:\programdata",
    r"c:\windows",
];

/// Whether executing this plan requires administrator privileges.
///
/// Two independent triggers: an explicit all-users install (which writes
/// the machine-wide registry hive), or a destination under a protected
/// root. A per-user install into a writable folder needs nothing, so the
/// wizard runs start to finish without ever showing a UAC prompt.
pub fn needs_elevation(options: &InstallOptions) -> bool {
    if matches!(options.scope, InstallScope::AllUsers) {
        return true;
    }
    path_requires_elevation(&options.destination)
}

/// Whether writing to — or *removing from* — `path` requires administrator
/// rights because it sits under a protected system root.
///
/// The install path uses this to decide whether to relaunch elevated before
/// copying files; the uninstall path uses the same rule so an install into
/// `C:\Program Files` can actually be deleted again (see
/// [`crate::state::InstallationManifest::needs_elevation_to_remove`]).
pub fn path_requires_elevation(path: &str) -> bool {
    is_protected_path(path)
}

/// True when `path` sits under a root that standard users can't write.
fn is_protected_path(path: &str) -> bool {
    let normalized = path.replace('/', "\\").to_lowercase();
    PROTECTED_ROOTS.iter().any(|root| {
        // Match the root itself or anything beneath it, never a sibling
        // that merely shares a prefix ("C:\Program Files Custom").
        normalized == *root
            || normalized.strip_prefix(root).is_some_and(|rest| rest.starts_with('\\'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Vec<Component> {
        vec![
            Component {
                id: "core".into(),
                name: "Main application".into(),
                description: "Core files".into(),
                size_bytes: 162 * 1_000_000,
                required: true,
                recommended_default: true,
            },
            Component {
                id: "gif".into(),
                name: "GIF encoder".into(),
                description: "FFmpeg".into(),
                size_bytes: 28 * 1_000_000,
                required: false,
                recommended_default: false,
            },
        ]
    }

    #[test]
    fn required_component_is_always_included() {
        // Caller selects nothing; core must still be in the plan.
        let plan = build_plan(InstallOptions::default(), &catalog(), &[]);
        assert!(plan.selected_components.contains(&"core".to_string()));
        assert_eq!(plan.component_bytes, 162 * 1_000_000);
    }

    #[test]
    fn optional_component_adds_to_footprint() {
        let plan = build_plan(InstallOptions::default(), &catalog(), &["gif".into()]);
        assert_eq!(plan.component_bytes, (162 + 28) * 1_000_000);
        assert!(plan.estimated_disk_bytes > plan.component_bytes);
    }

    /// Options for a per-user install into `dest`.
    fn user_install(dest: &str) -> InstallOptions {
        InstallOptions {
            destination: dest.to_string(),
            scope: InstallScope::CurrentUser,
            ..InstallOptions::default()
        }
    }

    #[test]
    fn default_program_files_destination_needs_elevation() {
        assert!(needs_elevation(&InstallOptions::default()));
    }

    #[test]
    fn writable_destination_installs_without_elevation() {
        assert!(!needs_elevation(&user_install(
            r"C:\Users\Sam\AppData\Local\Clippity"
        )));
        assert!(!needs_elevation(&user_install(r"D:\Apps\Clippity")));
    }

    #[test]
    fn protected_root_match_is_case_and_separator_insensitive() {
        assert!(needs_elevation(&user_install(r"c:\PROGRAM FILES\Clippity")));
        assert!(needs_elevation(&user_install("C:/Program Files/Clippity")));
        assert!(needs_elevation(&user_install(r"C:\Windows\Clippity")));
    }

    #[test]
    fn sibling_sharing_a_prefix_is_not_protected() {
        // "C:\Program Files Custom" is an ordinary writable folder — a
        // naive starts_with would wrongly demand elevation for it.
        assert!(!needs_elevation(&user_install(
            r"C:\Program Files Custom\Clippity"
        )));
    }

    #[test]
    fn all_users_scope_needs_elevation_anywhere() {
        let options = InstallOptions {
            destination: r"D:\Apps\Clippity".to_string(),
            scope: InstallScope::AllUsers,
            ..InstallOptions::default()
        };
        assert!(needs_elevation(&options));
    }
}
