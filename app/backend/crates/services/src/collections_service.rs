//! **Collections** — the catalog of named, ordered capture sets, stored
//! as one document beside the captures they arrange.
//!
//! `<captures>/collections.json`, next to the aux catalog's
//! `history.json`. It lives with the user's files rather than in the app
//! data dir because it *is* user data: a curated arrangement they made,
//! which should survive a reinstall and travel with a backed-up captures
//! folder. (The library index, by contrast, is app machinery and lives in
//! the data dir — it can be rebuilt from disk at any time; this cannot.)
//!
//! Membership is by capture id, and for a file-backed capture the id is
//! its path — which changes when it is trashed or restored. [`Self::rekey`]
//! is called at those choke points, right beside `sidecar::relocate`, so a
//! curated order survives a round trip through the trash. [`Self::forget`]
//! runs on purge, once the capture is gone for good.
//!
//! An id whose capture is missing is *not* pruned on sight. A file can be
//! absent for reasons that reverse — an unplugged drive, a folder moved
//! and moved back — and a collection that quietly forgot its members
//! every time one blinked would be worse than one that renders a shorter
//! list today. See ADR 0029.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::settings_service::CapturesDirSource;
use clippity_domain::collections::{self, Collection, CollectionCatalog};
use clippity_infra::error::{AppError, AppResult};

/// File name of the collections document under the captures dir. The
/// library scan skips it by name — it is a catalog, not a capture.
pub const CATALOG_FILE_NAME: &str = "collections.json";

pub struct CollectionsService {
    captures: Arc<dyn CapturesDirSource>,
    /// Serializes read-modify-write of the document, so two windows
    /// adding to different collections can't clobber each other. Same
    /// shape as the library's aux-catalog lock.
    lock: Mutex<()>,
}

impl CollectionsService {
    pub fn new(captures: Arc<dyn CapturesDirSource>) -> Self {
        Self {
            captures,
            lock: Mutex::new(()),
        }
    }

    fn path(&self) -> PathBuf {
        self.captures.captures_dir().join(CATALOG_FILE_NAME)
    }

    /// Every collection, in creation order. A missing or unparseable
    /// document reads as "no collections" — the same best-effort rule
    /// the aux catalog follows, because a corrupt file must not take the
    /// library down with it.
    pub fn list(&self) -> Vec<Collection> {
        let Ok(bytes) = fs::read(self.path()) else {
            return Vec::new();
        };
        serde_json::from_slice::<CollectionCatalog>(&bytes)
            .map(|c| c.collections)
            .unwrap_or_default()
    }

    fn save(&self, collections: Vec<Collection>) -> AppResult<()> {
        let dir = self.captures.captures_dir();
        fs::create_dir_all(&dir)
            .map_err(|e| AppError::Library(format!("create captures dir: {e}")))?;
        let json = serde_json::to_vec_pretty(&CollectionCatalog::new(collections))
            .map_err(|e| AppError::Library(format!("serialize collections: {e}")))?;
        fs::write(self.path(), json)
            .map_err(|e| AppError::Library(format!("write collections: {e}")))
    }

    /// Load → mutate → save under the write lock. The one shape every
    /// mutation here has; `edit` returns whatever the caller wants back.
    fn update<T>(&self, edit: impl FnOnce(&mut Vec<Collection>) -> AppResult<T>) -> AppResult<T> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| AppError::Library("collections lock poisoned".into()))?;
        let mut collections = self.list();
        let out = edit(&mut collections)?;
        self.save(collections)?;
        Ok(out)
    }

    /// Create an empty collection. A blank name is rejected — an unnamed
    /// collection is unfindable, and the rail would render a gap.
    pub fn create(&self, name: &str) -> AppResult<Collection> {
        let name = collections::normalize_name(name)
            .ok_or_else(|| AppError::Library("a collection needs a name".into()))?;
        let created = Collection::new(new_collection_id(), name, now_ms());
        let out = created.clone();
        self.update(|all| {
            all.push(created);
            Ok(())
        })?;
        Ok(out)
    }

    /// Rename. Duplicate names are allowed: the id is the identity, and
    /// refusing a name the user has used elsewhere would be a rule they
    /// never asked for.
    pub fn rename(&self, id: &str, name: &str) -> AppResult<Collection> {
        let name = collections::normalize_name(name)
            .ok_or_else(|| AppError::Library("a collection needs a name".into()))?;
        self.update(|all| {
            let collection = find_mut(all, id)?;
            collection.name = name;
            collection.updated_at_ms = now_ms();
            Ok(collection.clone())
        })
    }

    /// Delete a collection. The captures in it are untouched — a
    /// collection is an arrangement of files, not a folder holding them.
    pub fn remove(&self, id: &str) -> AppResult<()> {
        self.update(|all| {
            let before = all.len();
            all.retain(|c| c.id != id);
            if all.len() == before {
                return Err(AppError::Library("collection not found".into()));
            }
            Ok(())
        })
    }

    /// Append captures to a collection, skipping ones already in it.
    pub fn add_members(&self, id: &str, capture_ids: &[String]) -> AppResult<Collection> {
        self.update(|all| {
            let collection = find_mut(all, id)?;
            if collection.add_members(capture_ids.iter().cloned()) > 0 {
                collection.updated_at_ms = now_ms();
            }
            Ok(collection.clone())
        })
    }

    /// Remove captures from a collection.
    pub fn remove_members(&self, id: &str, capture_ids: &[String]) -> AppResult<Collection> {
        self.update(|all| {
            let collection = find_mut(all, id)?;
            if collection.remove_members(capture_ids) > 0 {
                collection.updated_at_ms = now_ms();
            }
            Ok(collection.clone())
        })
    }

    /// Rearrange a collection to `ordered` — see
    /// [`Collection::set_order`] for what happens to ids it forgets.
    pub fn set_order(&self, id: &str, ordered: &[String]) -> AppResult<Collection> {
        self.update(|all| {
            let collection = find_mut(all, id)?;
            let before = collection.members.clone();
            collection.set_order(ordered);
            if collection.members != before {
                collection.updated_at_ms = now_ms();
            }
            Ok(collection.clone())
        })
    }

    /// Load → mutate → save, but only when the mutation reports that it
    /// changed something. Every capture in the library passes through
    /// [`Self::rekey`] on its way to the trash, and the overwhelming
    /// majority of them belong to no collection at all — rewriting the
    /// document for each of those would be pure churn.
    fn update_if_changed(&self, edit: impl FnOnce(&mut Vec<Collection>) -> bool) -> AppResult<()> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| AppError::Library("collections lock poisoned".into()))?;
        let mut collections = self.list();
        if !edit(&mut collections) {
            return Ok(());
        }
        self.save(collections)
    }

    /// Follow a capture that changed id — a trash move, a restore, a
    /// future rename. Best-effort and silent: a failure here costs a
    /// collection a member, and must never fail the file op that
    /// prompted it (the capture itself has already moved).
    pub fn rekey(&self, from: &str, to: &str) {
        if let Err(e) = self.update_if_changed(|all| collections::rekey(all, from, to)) {
            tracing::warn!("collections: rekey failed: {e}");
        }
    }

    /// Drop a purged capture from every collection. Best-effort, for the
    /// same reason as [`Self::rekey`].
    pub fn forget(&self, capture_id: &str) {
        if let Err(e) = self.update_if_changed(|all| collections::forget(all, capture_id)) {
            tracing::warn!("collections: forget failed: {e}");
        }
    }
}

fn find_mut<'a>(all: &'a mut [Collection], id: &str) -> AppResult<&'a mut Collection> {
    all.iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::Library("collection not found".into()))
}

/// Per-process counter so two collections created in the same
/// millisecond can't share an id — the same guard the aux catalog's ids
/// use, and for the same reason (ids are minted before the lock).
static COLLECTION_SEQ: AtomicU64 = AtomicU64::new(0);

fn new_collection_id() -> String {
    let seq = COLLECTION_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("col_{}_{seq}", now_ms())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings_service::StaticCapturesDir;

    struct TestHarness {
        root: PathBuf,
        service: CollectionsService,
    }

    impl Drop for TestHarness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    static TEST_NONCE: AtomicU64 = AtomicU64::new(0);

    fn harness() -> TestHarness {
        let n = TEST_NONCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("clippity-collections-{}-{n}", now_ms()));
        fs::create_dir_all(&root).unwrap();
        let captures: Arc<dyn CapturesDirSource> = Arc::new(StaticCapturesDir(root.clone()));
        TestHarness {
            service: CollectionsService::new(captures),
            root,
        }
    }

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn an_untouched_library_has_no_collections() {
        let h = harness();
        assert!(h.service.list().is_empty());
    }

    #[test]
    fn create_then_list_round_trips_through_the_document() {
        let h = harness();
        let created = h.service.create("  Bug   reports ").unwrap();
        assert_eq!(created.name, "Bug reports");
        assert!(created.id.starts_with("col_"));
        let all = h.service.list();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, created.id);
    }

    #[test]
    fn a_blank_name_is_refused() {
        let h = harness();
        assert!(h.service.create("   ").is_err());
        assert!(h.service.list().is_empty());
    }

    #[test]
    fn two_collections_created_together_get_different_ids() {
        let h = harness();
        let a = h.service.create("A").unwrap();
        let b = h.service.create("B").unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(h.service.list().len(), 2);
    }

    #[test]
    fn duplicate_names_are_allowed_because_the_id_is_the_identity() {
        let h = harness();
        let a = h.service.create("Docs").unwrap();
        let b = h.service.create("Docs").unwrap();
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn rename_keeps_the_id_and_the_members() {
        let h = harness();
        let c = h.service.create("Old").unwrap();
        h.service.add_members(&c.id, &v(&["/caps/a.png"])).unwrap();
        let renamed = h.service.rename(&c.id, "New").unwrap();
        assert_eq!(renamed.id, c.id);
        assert_eq!(renamed.name, "New");
        assert_eq!(renamed.members, v(&["/caps/a.png"]));
    }

    #[test]
    fn removing_a_collection_leaves_the_others() {
        let h = harness();
        let a = h.service.create("A").unwrap();
        let b = h.service.create("B").unwrap();
        h.service.remove(&a.id).unwrap();
        let all = h.service.list();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, b.id);
        assert!(h.service.remove(&a.id).is_err(), "already gone");
    }

    #[test]
    fn membership_persists_and_keeps_its_curated_order() {
        let h = harness();
        let c = h.service.create("Walkthrough").unwrap();
        h.service
            .add_members(&c.id, &v(&["/caps/1.png", "/caps/2.png", "/caps/3.png"]))
            .unwrap();
        h.service
            .set_order(&c.id, &v(&["/caps/3.png", "/caps/1.png", "/caps/2.png"]))
            .unwrap();
        assert_eq!(
            h.service.list()[0].members,
            v(&["/caps/3.png", "/caps/1.png", "/caps/2.png"])
        );
    }

    #[test]
    fn adding_the_same_capture_twice_does_not_duplicate_it() {
        let h = harness();
        let c = h.service.create("C").unwrap();
        h.service.add_members(&c.id, &v(&["/caps/a.png"])).unwrap();
        let again = h.service.add_members(&c.id, &v(&["/caps/a.png"])).unwrap();
        assert_eq!(again.members.len(), 1);
    }

    #[test]
    fn a_capture_can_live_in_many_collections() {
        let h = harness();
        let a = h.service.create("A").unwrap();
        let b = h.service.create("B").unwrap();
        h.service.add_members(&a.id, &v(&["/caps/x.png"])).unwrap();
        h.service.add_members(&b.id, &v(&["/caps/x.png"])).unwrap();
        assert!(h.service.list().iter().all(|c| c.contains("/caps/x.png")));
    }

    #[test]
    fn membership_ops_on_a_missing_collection_error() {
        let h = harness();
        assert!(h.service.add_members("nope", &v(&["/caps/a.png"])).is_err());
        assert!(h.service.remove_members("nope", &v(&[])).is_err());
        assert!(h.service.set_order("nope", &v(&[])).is_err());
        assert!(h.service.rename("nope", "N").is_err());
    }

    #[test]
    fn rekey_carries_a_member_through_a_trash_move() {
        let h = harness();
        let c = h.service.create("C").unwrap();
        h.service
            .add_members(&c.id, &v(&["/caps/a.png", "/caps/b.png"]))
            .unwrap();
        h.service.rekey("/caps/a.png", "/caps/.trash/a.png");
        assert_eq!(
            h.service.list()[0].members,
            v(&["/caps/.trash/a.png", "/caps/b.png"]),
            "a trashed capture keeps its slot"
        );
        h.service.rekey("/caps/.trash/a.png", "/caps/a.png");
        assert_eq!(h.service.list()[0].members[0], "/caps/a.png");
    }

    #[test]
    fn forget_drops_a_purged_capture_everywhere() {
        let h = harness();
        let a = h.service.create("A").unwrap();
        let b = h.service.create("B").unwrap();
        h.service.add_members(&a.id, &v(&["/caps/x.png"])).unwrap();
        h.service.add_members(&b.id, &v(&["/caps/x.png"])).unwrap();
        h.service.forget("/caps/x.png");
        assert!(h.service.list().iter().all(|c| c.members.is_empty()));
    }

    #[test]
    fn a_corrupt_document_reads_as_no_collections() {
        // Best-effort, like the aux catalog: a hand-mangled file must not
        // be the reason the library won't open.
        let h = harness();
        fs::write(h.service.path(), b"{ not json").unwrap();
        assert!(h.service.list().is_empty());
        // ...and the next write repairs it.
        h.service.create("Fresh").unwrap();
        assert_eq!(h.service.list().len(), 1);
    }

    #[test]
    fn the_catalog_survives_a_new_service_over_the_same_dir() {
        let h = harness();
        h.service.create("Kept").unwrap();
        let reopened = CollectionsService::new(Arc::new(StaticCapturesDir(h.root.clone())));
        assert_eq!(reopened.list()[0].name, "Kept");
    }
}
