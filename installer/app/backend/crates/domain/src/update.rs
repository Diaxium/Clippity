//! Update / maintenance types and version-comparison rules.

use semver::Version;
use serde::{Deserialize, Serialize};

/// Release channel the user tracks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReleaseChannel {
    #[default]
    Stable,
    Beta,
    Nightly,
}

/// A resolved version + its channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub version: String,
    pub channel: ReleaseChannel,
}

/// Signature-verification state of a downloaded update package.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SignatureState {
    Unverified,
    Verified,
    Invalid,
}

/// The result of an online update check.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub installed: VersionInfo,
    pub latest: VersionInfo,
    pub available: bool,
    pub download_bytes: u64,
    pub signature: SignatureState,
    pub release_notes: Vec<String>,
    /// Browser page for the release whose notes are shown.
    pub release_page: String,
    /// RFC-3339 publication time supplied by the update source.
    pub published_at: String,
}

/// The authenticated metadata needed to download one Setup executable.
/// Kept out of the frontend contract so an apply always uses the exact
/// candidate the backend checked, never a URL supplied by webview code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePackage {
    pub version: String,
    pub channel: ReleaseChannel,
    pub download_url: String,
    pub download_bytes: u64,
    /// Lowercase SHA-256 published by GitHub for this immutable asset.
    pub sha256: String,
    pub release_page: String,
    pub published_at: String,
    pub release_notes: Vec<String>,
}

impl UpdatePackage {
    pub fn info_for(&self, installed: &str) -> UpdateInfo {
        UpdateInfo {
            installed: VersionInfo {
                version: installed.to_string(),
                channel: self.channel,
            },
            latest: VersionInfo {
                version: self.version.clone(),
                channel: self.channel,
            },
            available: is_update_available(installed, &self.version),
            download_bytes: self.download_bytes,
            // The metadata contains a digest, but the bytes are not verified
            // until download. Do not claim a completed verification early.
            signature: SignatureState::Unverified,
            release_notes: self.release_notes.clone(),
            release_page: self.release_page.clone(),
            published_at: self.published_at.clone(),
        }
    }
}

/// Snapshot shown on the maintenance hub for an existing install.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatus {
    pub installed: VersionInfo,
    pub install_dir: String,
    pub last_updated: String,
}

/// Compare two dotted numeric version strings (e.g. `"1.4.0"` vs
/// `"1.5.0"`). Missing trailing components are treated as zero, so
/// `"1.5"` and `"1.5.0"` are equal. Non-numeric segments sort as zero.
///
/// Returns [`std::cmp::Ordering`] of `a` relative to `b`.
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |value: &str| {
        let value = value.trim().trim_start_matches(['v', 'V']);
        Version::parse(value).or_else(|original| {
            if value
                .split('.')
                .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
            {
                let count = value.split('.').count();
                if count < 3 {
                    return Version::parse(&format!("{value}{}", ".0".repeat(3 - count)));
                }
            }
            Err(original)
        })
    };
    match (parse(a), parse(b)) {
        (Ok(a), Ok(b)) => a.cmp(&b),
        // Preserve a deterministic fallback for legacy manifests that did
        // not require SemVer, while never treating arbitrary text as newer.
        (Ok(_), Err(_)) => std::cmp::Ordering::Greater,
        (Err(_), Ok(_)) => std::cmp::Ordering::Less,
        (Err(_), Err(_)) => a.cmp(b),
    }
}

/// True when `latest` is strictly newer than `installed`.
pub fn is_update_available(installed: &str, latest: &str) -> bool {
    compare_versions(installed, latest) == std::cmp::Ordering::Less
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn newer_version_is_detected() {
        assert!(is_update_available("1.4.0", "1.5.0"));
        assert!(!is_update_available("1.5.0", "1.5.0"));
        assert!(!is_update_available("1.5.1", "1.5.0"));
    }

    #[test]
    fn missing_components_are_zero() {
        assert_eq!(compare_versions("1.5", "1.5.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.5", "1.5.1"), Ordering::Less);
    }

    #[test]
    fn channel_serializes_kebab() {
        let json = serde_json::to_string(&ReleaseChannel::Stable).unwrap();
        assert_eq!(json, "\"stable\"");
    }

    #[test]
    fn semver_prereleases_sort_before_their_release() {
        assert_eq!(compare_versions("v0.4.0-beta.2", "0.4.0"), Ordering::Less);
        assert_eq!(
            compare_versions("0.4.0-beta.2", "0.4.0-beta.10"),
            Ordering::Less
        );
    }

    #[test]
    fn package_info_does_not_claim_verification_before_download() {
        let package = UpdatePackage {
            version: "0.4.0".into(),
            channel: ReleaseChannel::Stable,
            download_url: "https://example.invalid/setup.exe".into(),
            download_bytes: 10,
            sha256: "00".repeat(32),
            release_page: "https://example.invalid/release".into(),
            published_at: "2026-09-08T00:00:00Z".into(),
            release_notes: vec!["One".into()],
        };
        let info = package.info_for("0.3.0");
        assert!(info.available);
        assert_eq!(info.signature, SignatureState::Unverified);
    }
}
