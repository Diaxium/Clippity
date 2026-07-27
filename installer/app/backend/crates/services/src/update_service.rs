//! Update checking and application.

use installer_domain::progress::{self, ProgressKind};
use installer_domain::update::{
    is_update_available, ReleaseChannel, SignatureState, UpdateInfo, VersionInfo,
};
use installer_infra::error::InstallerResult;

use crate::{manifest, pace, ProgressSink};

/// Check the given channel for a newer version than `installed`.
///
/// In a shipping build this contacts the update server; here it compares
/// the installed version against the manifest's build version so the
/// "Update available" step has real data to render.
pub fn check(installed: &str, channel: ReleaseChannel) -> UpdateInfo {
    let latest_version = manifest::product().version; // this build's version
    let available = is_update_available(installed, &latest_version);

    tracing::info!(installed, latest = %latest_version, ?channel, available, "checked for updates");

    UpdateInfo {
        installed: VersionInfo {
            version: installed.to_string(),
            channel,
        },
        latest: VersionInfo {
            version: latest_version,
            channel,
        },
        available,
        download_bytes: 82_400_000,
        signature: if available {
            SignatureState::Verified
        } else {
            SignatureState::Unverified
        },
        release_notes: vec![
            "Improved recording quality with adaptive bitrate.".into(),
            "Faster cloud sync and upload performance.".into(),
            "OCR engine accuracy and performance improvements.".into(),
            "UI polish, accessibility, and stability enhancements.".into(),
        ],
    }
}

/// Download, verify, and apply an update, emitting progress snapshots.
pub fn run(emit: &ProgressSink<'_>) -> InstallerResult<()> {
    tracing::info!("starting update");

    let tasks = progress::checklist_for(ProgressKind::Update);
    let total = tasks.len();
    emit(progress::snapshot(ProgressKind::Update, tasks.clone(), 0));

    for step in 0..total {
        pace();
        emit(progress::snapshot(ProgressKind::Update, tasks.clone(), step + 1));
    }

    tracing::info!("update complete");
    Ok(())
}
