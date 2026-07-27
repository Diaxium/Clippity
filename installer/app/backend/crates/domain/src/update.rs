//! Update / maintenance types and version-comparison rules.

use serde::{Deserialize, Serialize};

/// Release channel the user tracks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReleaseChannel {
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
    let parse = |s: &str| -> Vec<u64> {
        s.split('.')
            .map(|p| p.trim().parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (va, vb) = (parse(a), parse(b));
    let len = va.len().max(vb.len());
    for i in 0..len {
        let x = va.get(i).copied().unwrap_or(0);
        let y = vb.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
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
}
