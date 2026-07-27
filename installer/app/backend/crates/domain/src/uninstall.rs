//! Uninstall data-removal types and the removed/kept summary.

use serde::{Deserialize, Serialize};

/// A category of on-disk data the uninstaller can remove or keep.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCategory {
    pub id: String,
    pub name: String,
    pub size_bytes: u64,
    /// Destructive user content (captures, projects, credentials) —
    /// removal is opt-in and off by default. Application machinery is
    /// `false` and removed by default.
    pub destructive: bool,
}

/// The user's removal choices.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalSelection {
    pub remove_ids: Vec<String>,
    pub export_settings: bool,
    pub acknowledged: bool,
}

/// Computed totals shown on the Review-removal step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalSummary {
    pub removed_bytes: u64,
    pub kept_bytes: u64,
}

/// The default selection for a fresh uninstall: remove all
/// non-destructive application machinery, keep everything destructive.
/// This is the design's core promise — captures and projects survive
/// unless the user explicitly opts in.
pub fn default_removal(catalog: &[DataCategory]) -> RemovalSelection {
    let remove_ids = catalog
        .iter()
        .filter(|c| !c.destructive)
        .map(|c| c.id.clone())
        .collect();
    RemovalSelection {
        remove_ids,
        export_settings: false,
        acknowledged: false,
    }
}

/// Split the catalog into removed vs kept byte totals for a selection.
pub fn summarize(catalog: &[DataCategory], selection: &RemovalSelection) -> RemovalSummary {
    let mut removed_bytes = 0;
    let mut kept_bytes = 0;
    for c in catalog {
        if selection.remove_ids.iter().any(|id| id == &c.id) {
            removed_bytes += c.size_bytes;
        } else {
            kept_bytes += c.size_bytes;
        }
    }
    RemovalSummary {
        removed_bytes,
        kept_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Vec<DataCategory> {
        vec![
            DataCategory {
                id: "app".into(),
                name: "Application files".into(),
                size_bytes: 184 * 1_000_000,
                destructive: false,
            },
            DataCategory {
                id: "captures".into(),
                name: "Local captures".into(),
                size_bytes: 12_400 * 1_000_000,
                destructive: true,
            },
        ]
    }

    #[test]
    fn default_keeps_destructive_content() {
        let sel = default_removal(&catalog());
        assert!(sel.remove_ids.contains(&"app".to_string()));
        assert!(!sel.remove_ids.contains(&"captures".to_string()));
        assert!(!sel.acknowledged);
    }

    #[test]
    fn summary_splits_removed_and_kept() {
        let sel = default_removal(&catalog());
        let sum = summarize(&catalog(), &sel);
        assert_eq!(sum.removed_bytes, 184 * 1_000_000);
        assert_eq!(sum.kept_bytes, 12_400 * 1_000_000);
    }
}
