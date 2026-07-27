//! Persist and read the authoritative installation manifest
//! (`install-state.json`) in the maintenance directory.
//!
//! This is the single seam between an in-memory
//! [`installer_domain::state::InstallationManifest`] and its on-disk form.
//! Install writes it; detect / modify / repair / uninstall read it. It is
//! stored pretty-printed so a support engineer can read it by hand.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use serde::Deserialize;

use installer_domain::state::InstallationManifest;
use installer_infra::error::{other, InstallerResult};

/// File name of the on-disk manifest inside the maintenance directory.
pub const MANIFEST_FILE: &str = "install-state.json";

/// Absolute path of the manifest under a maintenance directory.
pub fn manifest_path(maintenance_dir: &Path) -> PathBuf {
    maintenance_dir.join(MANIFEST_FILE)
}

/// Derive a stable installation id from the install path + timestamp.
///
/// Deterministic for a given (path, time) pair and unique enough for our
/// purposes without pulling in a UUID dependency. Formatted GUID-style so
/// it reads like the identifier it is.
pub fn new_installation_id(install_dir: &str, install_date: &str) -> String {
    let digest = Sha256::digest(format!("{install_dir}|{install_date}").as_bytes());
    let hex = format!("{digest:x}");
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Write the manifest as pretty JSON, creating the maintenance dir.
pub fn write(maintenance_dir: &Path, manifest: &InstallationManifest) -> InstallerResult<()> {
    fs::create_dir_all(maintenance_dir)?;
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| other(format!("could not serialize the install manifest: {e}")))?;
    fs::write(manifest_path(maintenance_dir), json)?;
    tracing::info!(dir = %maintenance_dir.display(), "wrote installation manifest");
    Ok(())
}

/// Read the manifest back. `Ok(None)` when the file is absent; `Err` when
/// it exists but cannot be parsed (a corrupted or incompatible manifest —
/// the caller routes that to recovery).
pub fn read(maintenance_dir: &Path) -> InstallerResult<Option<InstallationManifest>> {
    let path = manifest_path(maintenance_dir);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    let manifest: InstallationManifest = serde_json::from_str(&raw)
        .map_err(|e| other(format!("the install manifest is unreadable: {e}")))?;
    Ok(Some(manifest))
}

/// Peek only the `schemaVersion` without a full parse, so detection can
/// recognise a manifest too new to trust even if the rest of the shape
/// has changed incompatibly.
pub fn peek_schema_version(maintenance_dir: &Path) -> Option<u32> {
    #[derive(Deserialize)]
    struct Peek {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
    }
    let raw = fs::read_to_string(manifest_path(maintenance_dir)).ok()?;
    serde_json::from_str::<Peek>(&raw).ok().map(|p| p.schema_version)
}

/// Remove the manifest file (leaving the maintenance dir for the cleanup
/// worker to remove last). A missing file is success.
pub fn remove(maintenance_dir: &Path) -> InstallerResult<()> {
    let path = manifest_path(maintenance_dir);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}
