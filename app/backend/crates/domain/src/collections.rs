//! **Collections** — named, manually ordered sets of captures. Pure: no
//! I/O, no clock.
//!
//! Tags and the favorite flag are *properties of a capture*, so they ride
//! in a record beside the capture itself (`domain::labels`). A collection
//! is not a property of anything: it has its own name, its own identity,
//! and — the part no per-capture record can express — its own **order**.
//! Two captures cannot between them say which of the two comes third in
//! "Onboarding walkthrough". So a collection is its own document, holding
//! its members as an ordered list of capture ids. See ADR 0029.
//!
//! The cost of that choice is that membership is keyed by an id which,
//! for a file-backed capture, is its path — and a path changes when the
//! capture is trashed or restored. [`rekey`] is what the service calls at
//! those choke points, alongside `sidecar::relocate`, so a curated order
//! survives a trip through the trash.
//!
//! Every operation here is total: adding a member twice, removing one
//! that was never there, or ordering by a list that names a stranger are
//! all no-ops rather than errors. A collection is a user's arrangement of
//! their own files, and there is no state of it worth refusing.

use serde::{Deserialize, Serialize};

/// On-disk schema version for the catalog. Additive changes need no bump
/// — the same rule the provenance and label records follow.
pub const SCHEMA_VERSION: u32 = 1;

/// Longest collection name we store. Names are shown whole in the rail,
/// so this is the width past which one stops being readable.
pub const MAX_NAME_LEN: usize = 60;

/// One collection: an identity, a name, and an ordered member list.
///
/// `members` holds capture ids (a file path, or an `aux_…` id) in the
/// order the user arranged them — *not* newest-first like the library.
/// Curated order is the whole point; a collection that re-sorted itself
/// by date would be a filter, not a collection.
///
/// An id in `members` whose capture no longer exists is not an error. It
/// is skipped when the collection is rendered and pruned when the capture
/// is purged, which keeps a temporarily-missing file (an external move, a
/// disconnected drive) from silently losing its place.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    /// Stable synthetic id, minted once (`col_<ms>_<seq>`) and never
    /// derived from the name — renaming a collection must not orphan it.
    pub id: String,
    pub name: String,
    pub created_at_ms: u128,
    /// Last time the name or the membership changed. Drives "recently
    /// used" ordering in the UI without a second bookkeeping field.
    pub updated_at_ms: u128,
    /// Capture ids in curated order.
    #[serde(default)]
    pub members: Vec<String>,
}

impl Collection {
    /// A new, empty collection. `name` is stored as given — callers
    /// normalise with [`normalize_name`] first, which is where a blank
    /// name is rejected.
    pub fn new(id: String, name: String, now_ms: u128) -> Self {
        Self {
            id,
            name,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            members: Vec::new(),
        }
    }

    /// Is `capture_id` in this collection?
    pub fn contains(&self, capture_id: &str) -> bool {
        self.members.iter().any(|m| m == capture_id)
    }

    /// Append every id not already a member, preserving the given order.
    /// Returns how many were actually added — zero means the call
    /// changed nothing and the caller can skip the write.
    pub fn add_members(&mut self, ids: impl IntoIterator<Item = String>) -> usize {
        let before = self.members.len();
        for id in ids {
            if id.is_empty() || self.contains(&id) {
                continue;
            }
            self.members.push(id);
        }
        self.members.len() - before
    }

    /// Drop every named id. Returns how many were removed.
    pub fn remove_members(&mut self, ids: &[String]) -> usize {
        let before = self.members.len();
        self.members.retain(|m| !ids.iter().any(|id| id == m));
        before - self.members.len()
    }

    /// Rearrange to `ordered`.
    ///
    /// Only current members are honoured, and any member `ordered` fails
    /// to mention keeps its relative place at the end. A drag-and-drop
    /// reorder races the list it was computed from — a capture added in
    /// another window between render and drop must not be deleted by an
    /// ordering that predates it.
    pub fn set_order(&mut self, ordered: &[String]) {
        let mut next: Vec<String> = Vec::with_capacity(self.members.len());
        for id in ordered {
            if self.contains(id) && !next.iter().any(|m| m == id) {
                next.push(id.clone());
            }
        }
        for id in &self.members {
            if !next.iter().any(|m| m == id) {
                next.push(id.clone());
            }
        }
        self.members = next;
    }

    /// Follow a capture that changed id — a trash move, a restore, a
    /// rename. Keeps the member's position. Returns whether anything
    /// changed.
    pub fn rekey(&mut self, from: &str, to: &str) -> bool {
        let mut changed = false;
        for member in self.members.iter_mut() {
            if member == from {
                *member = to.to_owned();
                changed = true;
            }
        }
        changed
    }
}

/// The whole catalog, as it sits in `<captures>/collections.json`.
///
/// An object rather than a bare array so a later field (a smart-collection
/// predicate, Library P4) can join without re-shaping the file — the same
/// reason the aux catalog is one.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCatalog {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub collections: Vec<Collection>,
}

impl CollectionCatalog {
    pub fn new(collections: Vec<Collection>) -> Self {
        Self {
            version: SCHEMA_VERSION,
            collections,
        }
    }
}

/// Pure: the storable form of a collection name, or `None` when there is
/// no name in it. Trims, collapses internal whitespace, truncates to
/// [`MAX_NAME_LEN`] — the same treatment `labels::normalize_tag` gives a
/// tag, for the same reason.
pub fn normalize_name(raw: &str) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(MAX_NAME_LEN).collect())
}

/// Pure: carry a changed capture id across every collection. The bulk
/// counterpart of [`Collection::rekey`], and what a trash move calls.
/// Returns whether any collection changed.
pub fn rekey(collections: &mut [Collection], from: &str, to: &str) -> bool {
    let mut changed = false;
    for collection in collections.iter_mut() {
        changed |= collection.rekey(from, to);
    }
    changed
}

/// Pure: drop a capture from every collection — what a purge calls, once
/// the file is gone for good.
pub fn forget(collections: &mut [Collection], capture_id: &str) -> bool {
    let ids = [capture_id.to_owned()];
    let mut changed = false;
    for collection in collections.iter_mut() {
        changed |= collection.remove_members(&ids) > 0;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    fn sample() -> Collection {
        let mut c = Collection::new("col_1".into(), "Onboarding".into(), 100);
        c.add_members(v(&["/caps/a.png", "/caps/b.png", "/caps/c.png"]));
        c
    }

    // ---------- membership ----------

    #[test]
    fn members_keep_the_order_they_were_added_in() {
        let c = sample();
        assert_eq!(c.members, v(&["/caps/a.png", "/caps/b.png", "/caps/c.png"]));
    }

    #[test]
    fn adding_a_member_twice_does_not_duplicate_it() {
        let mut c = sample();
        assert_eq!(c.add_members(v(&["/caps/b.png"])), 0);
        assert_eq!(c.members.len(), 3);
    }

    #[test]
    fn adding_reports_how_many_were_new() {
        let mut c = sample();
        assert_eq!(c.add_members(v(&["/caps/b.png", "/caps/d.png"])), 1);
        assert_eq!(c.members.last().unwrap(), "/caps/d.png");
    }

    #[test]
    fn an_empty_id_is_not_a_member() {
        let mut c = Collection::new("col_1".into(), "N".into(), 0);
        assert_eq!(c.add_members(v(&[""])), 0);
        assert!(c.members.is_empty());
    }

    #[test]
    fn removing_reports_how_many_went() {
        let mut c = sample();
        assert_eq!(c.remove_members(&v(&["/caps/a.png", "/caps/zz.png"])), 1);
        assert_eq!(c.members, v(&["/caps/b.png", "/caps/c.png"]));
    }

    // ---------- ordering ----------

    #[test]
    fn set_order_rearranges_the_members() {
        let mut c = sample();
        c.set_order(&v(&["/caps/c.png", "/caps/a.png", "/caps/b.png"]));
        assert_eq!(c.members, v(&["/caps/c.png", "/caps/a.png", "/caps/b.png"]));
    }

    #[test]
    fn set_order_keeps_members_the_order_forgot() {
        // A reorder computed before another window added a capture must
        // not delete it — it lands at the end instead.
        let mut c = sample();
        c.set_order(&v(&["/caps/c.png"]));
        assert_eq!(c.members, v(&["/caps/c.png", "/caps/a.png", "/caps/b.png"]));
    }

    #[test]
    fn set_order_ignores_ids_that_are_not_members() {
        let mut c = sample();
        c.set_order(&v(&["/caps/stranger.png", "/caps/b.png"]));
        assert_eq!(c.members, v(&["/caps/b.png", "/caps/a.png", "/caps/c.png"]));
    }

    #[test]
    fn set_order_tolerates_a_repeated_id() {
        let mut c = sample();
        c.set_order(&v(&["/caps/b.png", "/caps/b.png"]));
        assert_eq!(c.members.len(), 3);
        assert_eq!(c.members[0], "/caps/b.png");
    }

    // ---------- rekey / forget ----------

    #[test]
    fn rekey_keeps_a_members_position() {
        // A trashed capture must come back to the same slot, or a
        // curated order would shuffle every time something round-trips.
        let mut c = sample();
        assert!(c.rekey("/caps/b.png", "/caps/.trash/b.png"));
        assert_eq!(c.members[1], "/caps/.trash/b.png");
    }

    #[test]
    fn rekey_across_the_catalog_reports_whether_anything_moved() {
        let mut catalog = vec![sample(), Collection::new("col_2".into(), "Other".into(), 0)];
        assert!(rekey(&mut catalog, "/caps/a.png", "/caps/.trash/a.png"));
        assert!(!rekey(&mut catalog, "/caps/nobody.png", "/caps/x.png"));
        assert!(catalog[0].contains("/caps/.trash/a.png"));
    }

    #[test]
    fn forget_drops_a_capture_from_every_collection() {
        let mut second = Collection::new("col_2".into(), "Other".into(), 0);
        second.add_members(v(&["/caps/a.png"]));
        let mut catalog = vec![sample(), second];
        assert!(forget(&mut catalog, "/caps/a.png"));
        assert!(!catalog.iter().any(|c| c.contains("/caps/a.png")));
        assert!(
            !forget(&mut catalog, "/caps/a.png"),
            "second call is a no-op"
        );
    }

    // ---------- names ----------

    #[test]
    fn a_name_is_trimmed_and_collapsed() {
        assert_eq!(
            normalize_name("  Bug   reports  "),
            Some("Bug reports".into())
        );
    }

    #[test]
    fn a_blank_name_is_no_name() {
        assert_eq!(normalize_name("   \n"), None);
    }

    #[test]
    fn an_over_long_name_is_truncated_on_a_char_boundary() {
        let name = normalize_name(&"é".repeat(MAX_NAME_LEN + 5)).unwrap();
        assert_eq!(name.chars().count(), MAX_NAME_LEN);
    }

    // ---------- serde ----------

    #[test]
    fn round_trips_camel_case() {
        let catalog = CollectionCatalog::new(vec![sample()]);
        let json = serde_json::to_string(&catalog).unwrap();
        assert!(json.contains(r#""createdAtMs":100"#), "{json}");
        assert!(json.contains(r#""updatedAtMs":100"#), "{json}");
        let back: CollectionCatalog = serde_json::from_str(&json).unwrap();
        assert_eq!(back.collections, catalog.collections);
    }

    #[test]
    fn a_collection_without_members_still_parses() {
        let json = r#"{"collections":[{"id":"c","name":"N","createdAtMs":1,"updatedAtMs":1}]}"#;
        let catalog: CollectionCatalog = serde_json::from_str(json).unwrap();
        assert!(catalog.collections[0].members.is_empty());
    }
}
