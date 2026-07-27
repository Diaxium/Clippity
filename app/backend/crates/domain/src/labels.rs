//! Capture **labels** — what the *user* says about a capture, as opposed
//! to what the machine observed when it took one. Pure: no I/O, no clock.
//!
//! `domain::metadata` records provenance: the app, the window, the mode,
//! the instant. That record is written once, at the save choke point, and
//! is never edited afterwards — it is a statement about a moment that has
//! already happened. Labels are the opposite kind of fact: freeform tags
//! and a favorite flag, authored after the capture exists and rewritten
//! whenever the user changes their mind. Keeping the two in separate
//! records means a tag edit can never damage (or move the mtime of) a
//! provenance record it has nothing to say about. See ADR 0029.
//!
//! Tags are normalised on the way in ([`normalize_tag`]) and stored
//! sorted and deduplicated, so two captures the user considers identically
//! tagged produce byte-identical records — which in turn keeps the
//! library index's stamp from churning over spelling.

use serde::{Deserialize, Serialize};

/// On-disk schema version for [`CaptureLabels`]. Same additive rule as
/// `metadata::SCHEMA_VERSION`: bump only when a change cannot be
/// expressed as a new optional field.
pub const SCHEMA_VERSION: u32 = 1;

/// Longest tag we store. Long enough for "needs-redaction-before-share",
/// short enough that a chip stays a chip. Over-long input is truncated
/// rather than rejected — the user gets a tag they can see and edit,
/// instead of silence.
pub const MAX_TAG_LEN: usize = 48;

/// The persisted label record for one capture, written as
/// `<dir>/.labels/<file name>.json` by `services::sidecar`.
///
/// `file` names the capture it describes, for the same reason
/// `CaptureMetadata::file` does: the record travels with its capture, so
/// a bare name stays true where a path would go stale, and a reader can
/// spot a mismatched pairing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureLabels {
    /// [`SCHEMA_VERSION`] at write time.
    pub version: u32,
    /// File name (with extension) of the capture this describes.
    pub file: String,
    /// Freeform tags, normalised, deduplicated and sorted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Pinned by the user. Skipped when false so an unfavorited capture's
    /// record is indistinguishable from one that never had the flag.
    #[serde(default, skip_serializing_if = "is_not_favorite")]
    pub favorite: bool,
}

impl CaptureLabels {
    /// A record for `file` carrying `tags` and `favorite`, normalised.
    pub fn new(file: &str, tags: Vec<String>, favorite: bool) -> Self {
        Self {
            version: SCHEMA_VERSION,
            file: file.to_owned(),
            tags: normalize_tags(tags),
            favorite,
        }
    }

    /// Nothing left to say about this capture. The writer deletes the
    /// record rather than leaving an empty one behind, so removing a
    /// capture's last tag returns it to the pre-labels state exactly —
    /// including its stamp, which is what keeps the index from treating
    /// "no labels" and "labels removed" as different rows.
    pub fn is_empty(&self) -> bool {
        self.tags.is_empty() && !self.favorite
    }
}

fn is_not_favorite(favorite: &bool) -> bool {
    !*favorite
}

/// Pure: the storable form of one raw tag, or `None` when there is no
/// tag in it.
///
/// Trims, collapses internal whitespace runs to a single space (so
/// `"bug  report"` and `"bug report"` are one tag), and truncates to
/// [`MAX_TAG_LEN`] characters. Case is *preserved* — the user's spelling
/// is theirs — while [`normalize_tags`] compares case-insensitively, so
/// `Bug` and `bug` never coexist.
pub fn normalize_tag(raw: &str) -> Option<String> {
    let collapsed: String = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(MAX_TAG_LEN).collect())
}

/// Pure: normalise a whole list — drop the blanks, drop case-insensitive
/// duplicates (first spelling wins), sort case-insensitively.
///
/// Sorted because a tag set carries no order: leaving insertion order in
/// would make two identically-tagged captures produce different records,
/// and every one of those differences costs the index a rebuilt row.
pub fn normalize_tags(tags: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let Some(tag) = normalize_tag(&tag) else {
            continue;
        };
        if !out.iter().any(|kept| eq_ignore_case(kept, &tag)) {
            out.push(tag);
        }
    }
    sort_tags(&mut out);
    out
}

/// Pure: `existing` plus `adding`, normalised. Adding a tag a capture
/// already carries is a no-op, whatever its case.
pub fn add_tags(existing: &[String], adding: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut merged: Vec<String> = existing.to_vec();
    merged.extend(adding);
    normalize_tags(merged)
}

/// Pure: `existing` minus `removing`, compared case-insensitively so a
/// user can drop a chip without matching its capitalisation.
pub fn remove_tags(existing: &[String], removing: &[String]) -> Vec<String> {
    let drop: Vec<String> = removing.iter().filter_map(|t| normalize_tag(t)).collect();
    let mut kept: Vec<String> = existing
        .iter()
        .filter(|tag| !drop.iter().any(|d| eq_ignore_case(d, tag)))
        .cloned()
        .collect();
    sort_tags(&mut kept);
    kept
}

/// Pure: does `tags` contain `wanted`, ignoring case? The predicate a
/// tag filter is built from.
pub fn has_tag(tags: &[String], wanted: &str) -> bool {
    normalize_tag(wanted)
        .map(|w| tags.iter().any(|t| eq_ignore_case(t, &w)))
        .unwrap_or(false)
}

/// One label change, applied to whatever a capture currently carries.
///
/// The four edits differ only in how they transform a tag list and a
/// flag, so they are one type rather than four code paths: the service
/// reads a capture's labels, applies this, and writes back only if
/// something moved. That is also what makes a bulk edit free — the same
/// [`LabelEdit`] runs over a list of ids.
#[derive(Debug, Clone, Copy)]
pub enum LabelEdit<'a> {
    /// Star or unstar.
    Favorite(bool),
    /// Merge these tags in, keeping what is already there.
    AddTags(&'a [String]),
    /// Drop these tags, ignoring case and ignoring absent ones.
    RemoveTags(&'a [String]),
    /// Replace the tag list wholesale — the tag editor's "done".
    SetTags(&'a [String]),
}

impl LabelEdit<'_> {
    /// Apply to a capture's current labels in place. Returns whether
    /// anything actually changed, so the caller can skip a write (and
    /// with it, an index-invalidating mtime) for a no-op edit.
    pub fn apply(&self, tags: &mut Vec<String>, favorite: &mut bool) -> bool {
        match *self {
            Self::Favorite(next) => {
                let changed = *favorite != next;
                *favorite = next;
                changed
            }
            Self::AddTags(adding) => replace_tags(tags, add_tags(tags, adding.to_vec())),
            Self::RemoveTags(removing) => replace_tags(tags, remove_tags(tags, removing)),
            Self::SetTags(next) => replace_tags(tags, normalize_tags(next.to_vec())),
        }
    }
}

fn replace_tags(tags: &mut Vec<String>, next: Vec<String>) -> bool {
    if *tags == next {
        return false;
    }
    *tags = next;
    true
}

/// Case-insensitive sort. `sort_by_key` with a lowercased key would
/// allocate per comparison; this compares in place and falls back to the
/// case-sensitive order so the result is total (and therefore stable
/// across runs) when two tags differ only by case.
fn sort_tags(tags: &mut [String]) {
    tags.sort_by(|a, b| {
        let lower = a
            .chars()
            .flat_map(char::to_lowercase)
            .cmp(b.chars().flat_map(char::to_lowercase));
        lower.then_with(|| a.cmp(b))
    });
}

fn eq_ignore_case(a: &str, b: &str) -> bool {
    a.chars()
        .flat_map(char::to_lowercase)
        .eq(b.chars().flat_map(char::to_lowercase))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    // ---------- normalize_tag ----------

    #[test]
    fn a_tag_is_trimmed_and_its_whitespace_collapsed() {
        assert_eq!(normalize_tag("  bug  report "), Some("bug report".into()));
        assert_eq!(normalize_tag("bug\treport"), Some("bug report".into()));
        assert_eq!(normalize_tag("bug\n\nreport"), Some("bug report".into()));
    }

    #[test]
    fn a_blank_tag_is_no_tag() {
        assert_eq!(normalize_tag(""), None);
        assert_eq!(normalize_tag("   \t\n "), None);
    }

    #[test]
    fn a_tags_case_is_the_users_to_keep() {
        assert_eq!(normalize_tag("Bug Report"), Some("Bug Report".into()));
    }

    #[test]
    fn an_over_long_tag_is_truncated_on_a_char_boundary() {
        let long = "é".repeat(MAX_TAG_LEN + 10);
        let tag = normalize_tag(&long).unwrap();
        assert_eq!(tag.chars().count(), MAX_TAG_LEN);
    }

    // ---------- normalize_tags ----------

    #[test]
    fn a_tag_list_is_deduplicated_case_insensitively_first_spelling_wins() {
        assert_eq!(normalize_tags(v(&["Bug", "bug", "BUG"])), v(&["Bug"]));
    }

    #[test]
    fn a_tag_list_is_sorted_so_equal_sets_produce_equal_records() {
        // Two users tagging the same three things in different orders
        // must produce byte-identical records, or the index rebuilds a
        // row over nothing.
        let a = normalize_tags(v(&["zeta", "Alpha", "mid"]));
        let b = normalize_tags(v(&["mid", "zeta", "Alpha"]));
        assert_eq!(a, b);
        assert_eq!(a, v(&["Alpha", "mid", "zeta"]));
    }

    #[test]
    fn blanks_drop_out_of_a_list() {
        assert_eq!(normalize_tags(v(&["  ", "ok", ""])), v(&["ok"]));
    }

    // ---------- add / remove ----------

    #[test]
    fn adding_a_tag_already_present_changes_nothing() {
        let existing = v(&["Bug"]);
        assert_eq!(add_tags(&existing, v(&["bug"])), v(&["Bug"]));
    }

    #[test]
    fn adding_merges_and_re_sorts() {
        assert_eq!(
            add_tags(&v(&["beta"]), v(&["alpha", "gamma"])),
            v(&["alpha", "beta", "gamma"])
        );
    }

    #[test]
    fn removing_ignores_case() {
        assert_eq!(remove_tags(&v(&["Bug", "docs"]), &v(&["BUG"])), v(&["docs"]));
    }

    #[test]
    fn removing_something_absent_is_a_no_op() {
        assert_eq!(remove_tags(&v(&["docs"]), &v(&["bug"])), v(&["docs"]));
    }

    #[test]
    fn has_tag_matches_case_insensitively_and_rejects_blanks() {
        let tags = v(&["Bug Report"]);
        assert!(has_tag(&tags, "bug report"));
        assert!(has_tag(&tags, "  BUG   REPORT  "));
        assert!(!has_tag(&tags, "bug"));
        assert!(!has_tag(&tags, "   "));
    }

    // ---------- LabelEdit ----------

    fn apply(edit: LabelEdit<'_>, tags: &[&str], favorite: bool) -> (Vec<String>, bool, bool) {
        let mut tags = v(tags);
        let mut favorite = favorite;
        let changed = edit.apply(&mut tags, &mut favorite);
        (tags, favorite, changed)
    }

    #[test]
    fn favoriting_reports_a_change_only_when_the_flag_moves() {
        let (_, favorite, changed) = apply(LabelEdit::Favorite(true), &[], false);
        assert!(favorite && changed);
        let (_, favorite, changed) = apply(LabelEdit::Favorite(true), &[], true);
        assert!(favorite && !changed, "re-starring must not rewrite the record");
    }

    #[test]
    fn adding_a_tag_the_capture_already_has_is_not_a_change() {
        // The write it would trigger moves the sidecar's mtime, which
        // costs the index a rebuilt row for nothing.
        let (tags, _, changed) = apply(LabelEdit::AddTags(&v(&["BUG"])), &["Bug"], false);
        assert_eq!(tags, v(&["Bug"]));
        assert!(!changed);
    }

    #[test]
    fn adding_and_removing_tags_edits_the_list() {
        let (tags, _, changed) = apply(LabelEdit::AddTags(&v(&["alpha"])), &["beta"], false);
        assert_eq!(tags, v(&["alpha", "beta"]));
        assert!(changed);

        let (tags, _, changed) = apply(LabelEdit::RemoveTags(&v(&["BETA"])), &["beta"], false);
        assert!(tags.is_empty());
        assert!(changed);
    }

    #[test]
    fn setting_tags_replaces_the_list_and_normalises_it() {
        let (tags, _, changed) = apply(LabelEdit::SetTags(&v(&[" z ", "A", "a"])), &["old"], false);
        assert_eq!(tags, v(&["A", "z"]));
        assert!(changed);
        // Setting the same set again, differently spelled, is a no-op.
        let (_, _, changed) = apply(LabelEdit::SetTags(&v(&["z", "A"])), &["A", "z"], false);
        assert!(!changed);
    }

    #[test]
    fn an_edit_leaves_the_other_half_of_the_record_alone() {
        let (tags, favorite, _) = apply(LabelEdit::AddTags(&v(&["x"])), &[], true);
        assert!(favorite, "tagging must not un-star");
        let (kept, _, _) = apply(LabelEdit::Favorite(false), &["x"], true);
        assert_eq!(kept, tags, "starring must not disturb the tags");
    }

    // ---------- CaptureLabels ----------

    #[test]
    fn new_normalises_what_it_is_handed() {
        let labels = CaptureLabels::new("Shot.png", v(&["  b ", "B", "a"]), true);
        assert_eq!(labels.version, SCHEMA_VERSION);
        assert_eq!(labels.file, "Shot.png");
        assert_eq!(labels.tags, v(&["a", "b"]));
        assert!(labels.favorite);
    }

    #[test]
    fn a_record_with_no_tags_and_no_star_is_empty() {
        assert!(CaptureLabels::new("A.png", vec![], false).is_empty());
        assert!(!CaptureLabels::new("A.png", vec![], true).is_empty());
        assert!(!CaptureLabels::new("A.png", v(&["x"]), false).is_empty());
    }

    #[test]
    fn absent_labels_are_skipped_not_null() {
        let json = serde_json::to_string(&CaptureLabels::new("A.png", vec![], false)).unwrap();
        assert!(!json.contains("tags"), "{json}");
        assert!(!json.contains("favorite"), "{json}");
        assert!(json.contains(r#""file":"A.png""#), "{json}");
    }

    #[test]
    fn round_trips_camel_case() {
        let labels = CaptureLabels::new("Shot.png", v(&["docs", "bug"]), true);
        let json = serde_json::to_string(&labels).unwrap();
        assert!(json.contains(r#""favorite":true"#), "{json}");
        let back: CaptureLabels = serde_json::from_str(&json).unwrap();
        assert_eq!(back, labels);
    }

    #[test]
    fn a_minimal_record_still_parses() {
        // Same forward/backward compatibility rule as the provenance
        // record: the optional half is `serde(default)`.
        let record: CaptureLabels =
            serde_json::from_str(r#"{"version":1,"file":"A.png"}"#).unwrap();
        assert!(record.tags.is_empty());
        assert!(!record.favorite);
    }
}
