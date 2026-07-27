//! The concrete Clippity install manifest — the component catalog, the
//! uninstall data categories, and the product facts. This is the single
//! place that describes *what* Clippity ships, so the domain plan logic
//! stays generic and this is the only file that changes per release.

use installer_domain::install::Component;
use installer_domain::uninstall::DataCategory;
use installer_domain::wizard::ProductInfo;

const MB: u64 = 1_000_000;
const GB: u64 = 1_000_000_000;

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
        version: "0.1.0".into(),
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
            id: "assoc".into(),
            name: "File associations".into(),
            description: "Open supported files with Clippity".into(),
            size_bytes: 12 * MB,
            required: false,
            recommended_default: true,
        },
        Component {
            id: "startup".into(),
            name: "Startup helper".into(),
            description: "Faster launch and background tasks".into(),
            size_bytes: 6 * MB,
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
        Component {
            id: "cloud".into(),
            name: "Cloud sync (Beta)".into(),
            description: "Sync captures across devices".into(),
            size_bytes: 22 * MB,
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
            id: "credentials".into(),
            name: "Saved account credentials".into(),
            size_bytes: 2 * MB,
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
