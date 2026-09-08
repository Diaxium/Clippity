//! Online update discovery, verified download, and bundled-payload apply.
//!
//! The installed maintenance executable checks the project's GitHub releases,
//! downloads the matching self-contained Setup executable, verifies the exact
//! byte count and SHA-256 GitHub published for that asset, then runs that new
//! executable in a private `--apply-bundled-update` mode. The new setup applies
//! its embedded payload through the same journalled transaction as Install and
//! Modify, so the old maintenance binary never tries to interpret a future
//! package format.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use installer_domain::install::build_plan;
use installer_domain::progress::{self, ProgressKind};
use installer_domain::update::{
    compare_versions, is_update_available, ReleaseChannel, SignatureState, UpdateInfo,
    UpdatePackage, VersionInfo,
};
use installer_infra::error::{other, InstallerError, InstallerResult};
use installer_infra::paths::InstallerPaths;
use installer_platform::windows_ops;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::payload::Payload;
use crate::{detect, install_service, manifest, pace, ProgressSink};

const RELEASES_API: &str = "https://api.github.com/repos/Diaxium/Clippity/releases?per_page=30";
const USER_AGENT: &str = "Clippity-Updater";
const UPDATE_STATE_FILE: &str = "update-state.json";
const REMIND_LATER_SECS: u64 = 7 * 24 * 60 * 60;
const AUTOMATIC_CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    size: u64,
    digest: Option<String>,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    published_at: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<GithubAsset>,
}

/// Persistent update choices not owned by the application settings file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateState {
    #[serde(default)]
    channel: ReleaseChannel,
    #[serde(default)]
    deferred_version: Option<String>,
    #[serde(default)]
    deferred_until: Option<u64>,
    #[serde(default)]
    last_automatic_check: Option<u64>,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            channel: ReleaseChannel::Stable,
            deferred_version: None,
            deferred_until: None,
            last_automatic_check: None,
        }
    }
}

/// Check a release channel and return both the frontend summary and the exact
/// backend-only candidate that may later be applied.
pub fn check(
    installed: &str,
    channel: ReleaseChannel,
) -> InstallerResult<(UpdateInfo, Option<UpdatePackage>)> {
    let mut response = ureq::get(RELEASES_API)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| other(format!("could not contact the update service: {e}")))?;
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| other(format!("could not read the update response: {e}")))?;
    check_response(installed, channel, &body)
}

fn check_response(
    installed: &str,
    channel: ReleaseChannel,
    body: &str,
) -> InstallerResult<(UpdateInfo, Option<UpdatePackage>)> {
    let releases: Vec<GithubRelease> = serde_json::from_str(body)
        .map_err(|e| other(format!("the update response was not valid JSON: {e}")))?;

    let package = releases
        .into_iter()
        .filter(|r| release_matches(r, channel))
        .filter_map(|r| package_from_release(r, channel))
        .max_by(|a, b| compare_versions(&a.version, &b.version));

    let info = match &package {
        Some(package) => package.info_for(installed),
        None => UpdateInfo {
            installed: VersionInfo {
                version: installed.to_string(),
                channel,
            },
            latest: VersionInfo {
                version: installed.to_string(),
                channel,
            },
            available: false,
            download_bytes: 0,
            signature: SignatureState::Unverified,
            release_notes: Vec::new(),
            release_page: "https://github.com/Diaxium/Clippity/releases".into(),
            published_at: String::new(),
        },
    };
    tracing::info!(
        installed,
        latest = %info.latest.version,
        ?channel,
        available = info.available,
        "checked for updates"
    );
    Ok((
        info,
        package.filter(|p| is_update_available(installed, &p.version)),
    ))
}

fn release_matches(release: &GithubRelease, channel: ReleaseChannel) -> bool {
    if release.draft {
        return false;
    }
    let nightly = release.tag_name.to_ascii_lowercase().contains("nightly");
    match channel {
        ReleaseChannel::Stable => !release.prerelease,
        ReleaseChannel::Beta => !nightly,
        ReleaseChannel::Nightly => true,
    }
}

fn package_from_release(release: GithubRelease, channel: ReleaseChannel) -> Option<UpdatePackage> {
    let version = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    // Ignore non-SemVer release tags. They are useful for source snapshots,
    // but are not an installable ordering relation.
    semver::Version::parse(&version).ok()?;
    let expected_name = format!("Clippity-{version}-Setup.exe");
    let asset = release.assets.into_iter().find(|a| {
        a.name.eq_ignore_ascii_case(&expected_name)
            || a.name.to_ascii_lowercase().ends_with("-setup.exe")
    })?;
    let digest = asset.digest?.strip_prefix("sha256:")?.to_ascii_lowercase();
    if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }

    Some(UpdatePackage {
        version,
        channel,
        download_url: asset.browser_download_url,
        download_bytes: asset.size,
        sha256: digest,
        release_page: release.html_url,
        published_at: release.published_at.unwrap_or_default(),
        release_notes: release_notes(release.name.as_deref(), release.body.as_deref()),
    })
}

fn release_notes(name: Option<&str>, body: Option<&str>) -> Vec<String> {
    let mut notes: Vec<String> = body
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter_map(|line| line.strip_prefix("- "))
        .filter(|line| !line.is_empty())
        .take(6)
        .map(|line| line.trim_matches('*').to_string())
        .collect();
    if notes.is_empty() {
        if let Some(name) = name.filter(|name| !name.trim().is_empty()) {
            notes.push(name.to_string());
        }
    }
    notes
}

/// Remember the selected channel after a successful online check.
pub fn persist_channel(paths: &InstallerPaths, channel: ReleaseChannel) -> InstallerResult<()> {
    let maintenance = maintenance_dir(paths)?;
    let mut state = read_update_state(&maintenance);
    state.channel = channel;
    write_update_state(&maintenance, &state)
}

/// Snooze this exact release for one week. A newer release is never hidden by
/// an older reminder choice.
pub fn defer(paths: &InstallerPaths, version: &str) -> InstallerResult<()> {
    let maintenance = maintenance_dir(paths)?;
    let mut state = read_update_state(&maintenance);
    state.deferred_version = Some(version.to_string());
    state.deferred_until = Some(now_epoch().saturating_add(REMIND_LATER_SECS));
    write_update_state(&maintenance, &state)
}

/// Online update path used by the installed app's automatic checker.
pub fn run_automatic(
    paths: &InstallerPaths,
    wait_for_app: bool,
    no_restart: bool,
    emit: &ProgressSink<'_>,
) -> InstallerResult<()> {
    let (_, installed) = detect::locate_manifest(paths)
        .ok_or_else(|| InstallerError::Invalid("nothing is installed".into()))?;
    let maintenance = PathBuf::from(&installed.maintenance_directory);
    let mut state = read_update_state(&maintenance);
    let now = now_epoch();
    if state
        .last_automatic_check
        .is_some_and(|last| now.saturating_sub(last) < AUTOMATIC_CHECK_INTERVAL_SECS)
    {
        tracing::info!("automatic update check skipped; checked within 24 hours");
        return Ok(());
    }
    let (_, package) = check(&installed.version, state.channel)?;
    state.last_automatic_check = Some(now);
    write_update_state(&maintenance, &state)?;
    let Some(package) = package else {
        tracing::info!("automatic update check found no newer release");
        return Ok(());
    };
    if state.deferred_version.as_deref() == Some(package.version.as_str())
        && state.deferred_until.is_some_and(|until| until > now)
    {
        tracing::info!(version = %package.version, "update is snoozed");
        return Ok(());
    }
    run(&package, paths, wait_for_app, no_restart, emit)
}

/// Download, verify, and invoke a newer self-contained Setup executable.
pub fn run(
    package: &UpdatePackage,
    paths: &InstallerPaths,
    wait_for_app: bool,
    no_restart: bool,
    emit: &ProgressSink<'_>,
) -> InstallerResult<()> {
    let tasks = progress::checklist_for(ProgressKind::Update);
    emit(progress::snapshot(ProgressKind::Update, tasks.clone(), 0));

    let setup = download(package)?;
    emit(progress::snapshot(ProgressKind::Update, tasks.clone(), 1));
    verify_download(&setup, package)?;
    emit(progress::snapshot(ProgressKind::Update, tasks.clone(), 2));

    let (_, installed) = detect::locate_manifest(paths)
        .ok_or_else(|| InstallerError::Invalid("nothing is installed".into()))?;
    let needs_elevation =
        installed.needs_elevation_to_remove() && !installer_platform::is_elevated();
    let mut args = String::from("--apply-bundled-update --silent");
    if wait_for_app {
        args.push_str(" --wait-for-app");
    }
    if no_restart {
        args.push_str(" --no-restart");
    }

    if wait_for_app {
        // Scheduling must return immediately. The verified worker stays alive
        // until Clippity exits, then applies the bundled payload.
        if needs_elevation {
            windows_ops::relaunch_elevated(&setup, &args)?;
        } else {
            spawn_hidden(&setup, &args)?;
        }
    } else {
        let code = if needs_elevation {
            windows_ops::run_elevated_and_wait(&setup, &args, true)?
        } else {
            Command::new(&setup)
                .args(args.split_whitespace())
                .status()?
                .code()
                .unwrap_or(1603)
        };
        if code != 0 && code != 3010 {
            return Err(other(format!("update worker failed with exit code {code}")));
        }
        let _ = fs::remove_file(&setup);
    }

    for completed in 3..=tasks.len() {
        pace();
        emit(progress::snapshot(
            ProgressKind::Update,
            tasks.clone(),
            completed,
        ));
    }
    tracing::info!(version = %package.version, deferred = wait_for_app, "update completed");
    Ok(())
}

/// Apply the payload embedded in the currently running (new) Setup binary.
pub fn apply_bundled(
    paths: &InstallerPaths,
    wait_for_app: bool,
    no_restart: bool,
    emit: &ProgressSink<'_>,
) -> InstallerResult<()> {
    let (_, installed) = detect::locate_manifest(paths)
        .ok_or_else(|| InstallerError::Invalid("nothing is installed".into()))?;
    let payload = Payload::load()?;
    if !is_update_available(&installed.version, payload.version()) {
        tracing::info!(installed = %installed.version, bundled = %payload.version(), "already up to date");
        return Ok(());
    }
    if wait_for_app {
        wait_until_app_exits(&installed)?;
    } else {
        let targets: Vec<&Path> = installed.files.iter().map(|f| Path::new(&f.path)).collect();
        let report = crate::shutdown::clear_locks(
            &targets,
            &installed.install_directory,
            &installed.maintenance_directory,
        );
        if report.user_must_close_apps() {
            return Err(other(format!(
                "close these applications before updating: {}",
                report.blocking_apps.join(", ")
            )));
        }
    }

    let mut actual_paths = paths.clone();
    actual_paths.install_dir = installed.install_directory.clone().into();
    let plan = build_plan(
        manifest::effective_installed_options(&installed, paths),
        &manifest::components(),
        &installed.installed_components,
    );
    install_service::run(
        ProgressKind::Update,
        &plan,
        &manifest::product(),
        &actual_paths,
        &payload,
        emit,
    )?;

    if !no_restart {
        if let Some(exe) = installed.primary_exe() {
            let _ = Command::new(exe).spawn();
        }
    }
    Ok(())
}

fn wait_until_app_exits(
    installed: &installer_domain::state::InstallationManifest,
) -> InstallerResult<()> {
    let Some(exe) = installed.primary_exe() else {
        return Ok(());
    };
    let path = Path::new(exe);
    let own_pid = std::process::id();
    loop {
        let running = windows_ops::enumerate_lockers(&[path])?
            .into_iter()
            .any(|p| p.pid != own_pid);
        if !running {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn download(package: &UpdatePackage) -> InstallerResult<PathBuf> {
    let dir = std::env::temp_dir().join("Clippity Updates");
    fs::create_dir_all(&dir)?;
    // Remove stale completed/partial downloads from earlier checks.
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let _ = fs::remove_file(entry.path());
        }
    }
    let target = dir.join(format!("Clippity-{}-Setup.exe", package.version));
    let partial = target.with_extension("download");
    let mut response = ureq::get(&package.download_url)
        .header("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| {
            other(format!(
                "could not download update {}: {e}",
                package.version
            ))
        })?;
    let mut reader = response.body_mut().as_reader();
    let mut file = fs::File::create(&partial)?;
    let mut buffer = vec![0u8; 128 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])?;
    }
    file.flush()?;
    drop(file);
    fs::rename(&partial, &target)?;
    Ok(target)
}

fn verify_download(path: &Path, package: &UpdatePackage) -> InstallerResult<()> {
    let bytes = fs::read(path)?;
    if bytes.len() as u64 != package.download_bytes {
        let _ = fs::remove_file(path);
        return Err(InstallerError::SignatureInvalid);
    }
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(&package.sha256) {
        let _ = fs::remove_file(path);
        return Err(InstallerError::SignatureInvalid);
    }
    tracing::info!(path = %path.display(), sha256 = %actual, "verified update package");
    Ok(())
}

fn maintenance_dir(paths: &InstallerPaths) -> InstallerResult<PathBuf> {
    detect::locate_manifest(paths)
        .map(|(_, m)| PathBuf::from(m.maintenance_directory))
        .ok_or_else(|| InstallerError::Invalid("nothing is installed".into()))
}

fn read_update_state(maintenance: &Path) -> UpdateState {
    fs::read_to_string(maintenance.join(UPDATE_STATE_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_update_state(maintenance: &Path, state: &UpdateState) -> InstallerResult<()> {
    fs::create_dir_all(maintenance)?;
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|e| other(format!("could not serialize update settings: {e}")))?;
    fs::write(maintenance.join(UPDATE_STATE_FILE), bytes)?;
    Ok(())
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn spawn_hidden(exe: &Path, args: &str) -> InstallerResult<()> {
    let mut command = Command::new(exe);
    command.args(args.split_whitespace());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn release_json(prerelease: bool, tag: &str, digest: &str) -> String {
        format!(
            r#"[{{
                "tag_name":"{tag}","name":"Release {tag}","body":"- First fix\n- Second fix",
                "html_url":"https://example.test/{tag}","published_at":"2026-09-08T00:00:00Z",
                "draft":false,"prerelease":{prerelease},"assets":[{{
                    "name":"Clippity-{}-Setup.exe","size":3,"digest":"sha256:{digest}",
                    "browser_download_url":"https://example.test/setup.exe"
                }}]
            }}]"#,
            tag.trim_start_matches('v')
        )
    }

    #[test]
    fn stable_ignores_prereleases_while_beta_accepts_them() {
        let body = release_json(true, "v0.4.0-beta.1", &"a".repeat(64));
        assert!(
            !check_response("0.3.0", ReleaseChannel::Stable, &body)
                .unwrap()
                .0
                .available
        );
        assert!(
            check_response("0.3.0", ReleaseChannel::Beta, &body)
                .unwrap()
                .0
                .available
        );
    }

    #[test]
    fn a_release_without_a_published_sha_is_not_installable() {
        let body = release_json(false, "v0.4.0", "not-a-digest");
        let (info, package) = check_response("0.3.0", ReleaseChannel::Stable, &body).unwrap();
        assert!(!info.available);
        assert!(package.is_none());
    }

    #[test]
    fn highest_semver_release_wins_not_api_order() {
        let a = release_json(false, "v0.4.0", &"a".repeat(64));
        let b = release_json(false, "v0.5.0", &"b".repeat(64));
        let body = format!("[{},{}]", &a[1..a.len() - 1], &b[1..b.len() - 1]);
        let (_, package) = check_response("0.3.0", ReleaseChannel::Stable, &body).unwrap();
        assert_eq!(package.unwrap().version, "0.5.0");
    }

    #[test]
    fn downloaded_bytes_must_match_size_and_sha() {
        static N: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "clippity-update-verify-{}.exe",
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&path, b"abc").unwrap();
        let package = UpdatePackage {
            version: "0.4.0".into(),
            channel: ReleaseChannel::Stable,
            download_url: String::new(),
            download_bytes: 3,
            sha256: format!("{:x}", Sha256::digest(b"abc")),
            release_page: String::new(),
            published_at: String::new(),
            release_notes: vec![],
        };
        verify_download(&path, &package).unwrap();
        let mut bad = package.clone();
        bad.sha256 = "0".repeat(64);
        assert!(matches!(
            verify_download(&path, &bad),
            Err(InstallerError::SignatureInvalid)
        ));
        assert!(!path.exists(), "a rejected package is deleted");
    }
}
