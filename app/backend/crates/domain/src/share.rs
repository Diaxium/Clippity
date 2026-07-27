//! Share-feature domain types + pure rules.
//!
//! "Share" here means the OS-level half of the
//! [sharing roadmap](../../../../docs/roadmaps/sharing-export.md): hand a
//! capture that already exists on disk to something outside Clippity.
//! Nothing in this module uploads, and nothing here decides *when* to
//! share — the caller has already saved a file and the user has already
//! picked a target. That keeps the privacy baseline the roadmap asks
//! for: sharing is always an explicit, per-capture act.
//!
//! Wire format: kebab-case enum, mirroring `domain::overlay`.

use serde::{Deserialize, Serialize};

/// Where a saved capture should be handed off to.
///
/// Deliberately small. Upload destinations (HTTP endpoint, S3, cloud
/// share links) are Phase 3/4 of the sharing roadmap and need auth
/// storage + a share-history model before they can be added here; these
/// three need nothing but a path that exists.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ShareTarget {
    /// Show the file selected in the OS file manager. The most useful
    /// one on desktop: from Explorer the user can drag it anywhere.
    Reveal,
    /// Open the file with whatever the OS has registered for its type.
    Open,
    /// Put the absolute path on the clipboard, for pasting into a
    /// terminal, an upload dialog, or a chat message.
    CopyPath,
}

impl ShareTarget {
    /// Human-readable name for logs and error messages.
    pub fn label(self) -> &'static str {
        match self {
            ShareTarget::Reveal => "reveal in folder",
            ShareTarget::Open => "open",
            ShareTarget::CopyPath => "copy path",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_target_round_trips_kebab_case() {
        assert_eq!(
            serde_json::to_string(&ShareTarget::CopyPath).unwrap(),
            "\"copy-path\""
        );
        assert_eq!(
            serde_json::from_str::<ShareTarget>("\"reveal\"").unwrap(),
            ShareTarget::Reveal
        );
        assert_eq!(
            serde_json::from_str::<ShareTarget>("\"open\"").unwrap(),
            ShareTarget::Open
        );
    }

    #[test]
    fn every_target_has_a_label() {
        for t in [
            ShareTarget::Reveal,
            ShareTarget::Open,
            ShareTarget::CopyPath,
        ] {
            assert!(!t.label().is_empty());
        }
    }
}
