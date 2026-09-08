//! The concrete Clippity install manifest — the component catalog, the
//! uninstall data categories, and the product facts. This is the single
//! place that describes *what* Clippity ships, so the domain plan logic
//! stays generic and this is the only file that changes per release.

use installer_domain::install::{Component, InstallOptions};
use installer_domain::state::InstallationManifest;
use installer_domain::uninstall::DataCategory;
use installer_domain::wizard::ProductInfo;
use installer_infra::paths::InstallerPaths;

const MB: u64 = 1_000_000;
const GB: u64 = 1_000_000_000;

/// Resolve maintenance options from the committed manifest plus preferences
/// the installed app may have changed since Setup last ran. Every Modify and
/// Update path must use this view so an unrelated operation never reverts a
/// live app-side choice.
pub fn effective_installed_options(
    installed: &InstallationManifest,
    paths: &InstallerPaths,
) -> InstallOptions {
    let mut options = installed.installed_options();
    let settings = paths.local_data.join("data").join("settings.json");
    if let Ok(bytes) = std::fs::read(settings) {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            apply_live_general(&mut options, &value);
        }
    }
    options
}

fn apply_live_general(options: &mut InstallOptions, settings: &serde_json::Value) {
    let Some(general) = settings.get("general") else {
        return;
    };
    if let Some(value) = general.get("startOnStartup").and_then(|v| v.as_bool()) {
        options.start_at_login = value;
    }
    if let Some(value) = general.get("automaticUpdates").and_then(|v| v.as_bool()) {
        options.automatic_updates = value;
    }
    if let Some(value) = general.get("helpImprove").and_then(|v| v.as_bool()) {
        options.help_improve = value;
    }
}

/// Product facts for this build.
///
/// `version` is the application version the wizard *carries* — it must
/// match the embedded payload (`payload/payload.json`), which the detection
/// and update-check logic compares against the installed manifest. Keeping
/// these in sync is what makes "an update is available" honest; see
/// [`crate::payload::Payload::version`].
pub fn product() -> ProductInfo {
    ProductInfo {
        name: "Clippity".into(),
        version: "0.3.1".into(),
        arch: "64-bit".into(),
        publisher: "Clippity".into(),
        default_install_dir: installer_infra::paths::DEFAULT_INSTALL_DIR.into(),
    }
}

/// The selectable components shown in the Components / Modify steps.
pub fn components() -> Vec<Component> {
    vec![
        Component {
            id: "core".into(),
            name: "Main application".into(),
            description: "Core Clippity application files".into(),
            size_bytes: 162 * MB,
            required: true,
            recommended_default: true,
        },
        Component {
            id: "capture".into(),
            name: "Capture integration".into(),
            description: "Enable global capture and shortcuts".into(),
            size_bytes: 48 * MB,
            required: false,
            recommended_default: true,
        },
        Component {
            id: "gif".into(),
            name: "GIF encoder (FFmpeg)".into(),
            description: "Create high-quality GIFs".into(),
            size_bytes: 28 * MB,
            required: false,
            recommended_default: false,
        },
        Component {
            id: "ocr".into(),
            name: "OCR engine".into(),
            description: "Extract text from screenshots".into(),
            size_bytes: 36 * MB,
            required: false,
            recommended_default: false,
        },
    ]
}

/// The on-disk data categories the uninstaller reasons about.
pub fn data_categories() -> Vec<DataCategory> {
    vec![
        DataCategory {
            id: "app".into(),
            name: "Application files".into(),
            size_bytes: 184 * MB,
            destructive: false,
        },
        DataCategory {
            id: "shortcuts".into(),
            name: "Shortcuts and system integrations".into(),
            size_bytes: 4 * MB,
            destructive: false,
        },
        DataCategory {
            id: "cache".into(),
            name: "Cached files".into(),
            size_bytes: 326 * MB,
            destructive: false,
        },
        DataCategory {
            id: "settings".into(),
            name: "Settings and presets".into(),
            size_bytes: 8 * MB,
            destructive: true,
        },
        DataCategory {
            id: "content".into(),
            name: "Local captures and projects".into(),
            size_bytes: 14 * GB + 500 * MB,
            destructive: true,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_app_preferences_override_stale_manifest_options() {
        let mut options = InstallOptions {
            start_at_login: false,
            automatic_updates: false,
            help_improve: true,
            ..InstallOptions::default()
        };
        let settings = serde_json::json!({
            "general": {
                "startOnStartup": true,
                "automaticUpdates": true,
                "helpImprove": false
            }
        });

        apply_live_general(&mut options, &settings);

        assert!(options.start_at_login);
        assert!(options.automatic_updates);
        assert!(!options.help_improve);
    }

    #[test]
    fn absent_or_wrong_typed_live_fields_leave_manifest_options_alone() {
        let mut options = InstallOptions {
            start_at_login: true,
            automatic_updates: false,
            ..InstallOptions::default()
        };
        apply_live_general(
            &mut options,
            &serde_json::json!({ "general": { "startOnStartup": "yes" } }),
        );
        assert!(options.start_at_login);
        assert!(!options.automatic_updates);
    }
}
