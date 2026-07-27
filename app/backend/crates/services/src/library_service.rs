//! Library orchestration — filesystem-backed capture inventory with
//! thumbnail decode, trash/restore, and storage stats.
//!
//! **The filesystem is the source of truth.** A capture is its file;
//! its description is the `.meta` sidecar beside it (ADR 0026). A
//! SQLite index (`services::library_index`) caches the rows those two
//! produce, but it is reconciled against disk before every read — see
//! [`LibraryService::list`] — so it can only ever make listing *faster*,
//! never make it disagree with what's on disk. With no index (it failed
//! to open, or the caller didn't ask for one) [`LibraryService::list`]
//! falls back to scanning, which is what it always did.
//!
//! Persistence model:
//! - Active captures live directly in `<paths.captures>/`.
//! - Soft-deleted captures live in `<paths.captures>/.trash/`.
//! - Permanent delete removes the file.
//! - Non-file entries (color / palette / text) live in the aux catalog,
//!   `history.json`, and are mirrored into the index so one query
//!   covers the whole library.
//! - A capture's **tags and favorite flag** live in a `.labels` sidecar
//!   beside it (ADR 0029); an aux entry's live on its catalog row, since
//!   there is no file to hang a sidecar off. Either way they are read
//!   back into the same `CaptureMeta` fields, so a caller cannot tell
//!   which storage a row came from.
//! - **Collection membership is not here.** A collection is ordered, so
//!   it is its own document (`services::collections_service`); what this
//!   service owes it is carrying a capture's id across a trash move.
//!
//! Concurrency: filesystem ops are atomic per-call. Service-side state
//! is the aux write lock and the index handle.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use image::{ImageFormat, ImageReader};

use clippity_domain::labels::{CaptureLabels, LabelEdit};
use clippity_domain::library::{self, AuxColor, CaptureKind, CaptureMeta, StorageInfo};
use clippity_infra::error::{AppError, AppResult};
use crate::collections_service::{self, CollectionsService};
use crate::library_index::{
    FacetsQuery, LibraryFacets, LibraryIndex, LibraryQuery, QueryPage, Stamp,
};
use crate::settings_service::CapturesDirSource;
use crate::sidecar;

/// Display cap for `StorageInfo.total_bytes`. Cross-platform free-
/// disk-space via Tauri v2's path API is unreliable, so the UI
/// renders a progress bar against this generous fixed cap until
/// the settings port adds a configurable override.
const STORAGE_TOTAL_BYTES_CAP: u64 = 10 * 1024 * 1024 * 1024; // 10 GiB

/// Subdirectory under `paths.captures/` that holds soft-deleted
/// captures. Same shape as the legacy library's `.trash`.
const TRASH_DIRNAME: &str = ".trash";

/// Aux catalog filename under the captures dir. Stores the non-file
/// (color / palette / text) entries (ADR 0006). Named to match the
/// legacy catalog so an existing one is picked up on upgrade.
const AUX_CATALOG_FILE: &str = "history.json";

pub struct LibraryService {
    captures: Arc<dyn CapturesDirSource>,
    /// Serializes read-modify-write of the aux catalog so concurrent
    /// color / palette saves don't clobber each other.
    aux_lock: Mutex<()>,
    /// The listing cache. `None` when the database could not be opened
    /// — the library then scans, exactly as it did before the index
    /// existed. A cache is never allowed to be the reason a user can't
    /// see their captures.
    index: Option<LibraryIndex>,
    /// Shared with `AppState`, which serves the collection commands from
    /// the same instance. It is held *here* because a capture's id
    /// changes inside [`Self::delete`] / [`Self::restore`] / [`Self::purge`],
    /// and the collections that reference it have to be carried across
    /// at that choke point — the same argument that put `sidecar::relocate`
    /// there (ADR 0029).
    collections: Arc<CollectionsService>,
}

impl LibraryService {
    /// Build the service over `captures`, caching listings in the
    /// SQLite index at `index_db` when one is given.
    ///
    /// A database that won't open is logged and dropped, not
    /// propagated: startup must not fail over a cache, and the
    /// scanning path answers every question the index does.
    pub fn new(
        captures: Arc<dyn CapturesDirSource>,
        index_db: Option<&Path>,
        collections: Arc<CollectionsService>,
    ) -> Self {
        let index = index_db.and_then(|path| match LibraryIndex::open(path) {
            Ok(index) => Some(index),
            Err(e) => {
                tracing::warn!(
                    "library index unavailable ({e}); listing will scan the filesystem"
                );
                None
            }
        });
        Self {
            captures,
            aux_lock: Mutex::new(()),
            index,
            collections,
        }
    }

    fn captures_dir(&self) -> PathBuf {
        self.captures.captures_dir()
    }

    /// The captures dir (+ `.trash` if requested) as a newest-first
    /// vector of `CaptureMeta`. A missing dir is silent (empty result),
    /// not an error — it may not exist on first launch.
    ///
    /// Served from the index when there is one, after reconciling it
    /// against disk ([`Self::reconcile`]); by scanning when there
    /// isn't. The two paths are required to be indistinguishable to a
    /// caller, which is why the same test suite runs over both.
    pub fn list(&self, include_trashed: bool) -> AppResult<Vec<CaptureMeta>> {
        let Some(index) = self.index.as_ref() else {
            return Ok(self.scan(include_trashed));
        };
        match self.reconcile(index).and_then(|()| index.rows(include_trashed)) {
            Ok(rows) => Ok(rows),
            Err(e) => {
                // The cache broke mid-flight (locked file, disk full,
                // corruption). Answer from disk rather than fail: the
                // index is an accelerator, and losing it costs speed,
                // not correctness.
                tracing::warn!("library index read failed ({e}); scanning instead");
                Ok(self.scan(include_trashed))
            }
        }
    }

    /// One filtered, searched, sorted *page* of the listing — the same
    /// reconcile-then-read contract as [`Self::list`], but with the grid's
    /// narrowing pushed into SQL so a large library materializes only the
    /// page a caller shows (performance roadmap P5). Falls back to a full
    /// scan + the in-memory twin of the query when there is no index or it
    /// fails, so the answer is identical either way.
    pub fn query(&self, q: &LibraryQuery) -> AppResult<QueryPage> {
        // The scan's flag is still a superset — the trash *view* narrows
        // to the deleted half inside `apply_in_memory`, which can only do
        // that if the scan walked the trash directory in the first place.
        let scan_trashed = q.trash.needs_trash();
        let Some(index) = self.index.as_ref() else {
            return Ok(q.apply_in_memory(self.scan(scan_trashed)));
        };
        match self.reconcile(index).and_then(|()| index.query(q)) {
            Ok(page) => Ok(page),
            Err(e) => {
                tracing::warn!("library index query failed ({e}); scanning instead");
                Ok(q.apply_in_memory(self.scan(scan_trashed)))
            }
        }
    }

    /// Every count the destination rail shows, aggregated over the whole
    /// library — same reconcile-then-read contract as [`Self::list`].
    ///
    /// This is the other half of what a paged grid needs: [`Self::query`]
    /// answers "what is on this page", and a rail cannot be built from
    /// that answer, because its counts span every row the page left
    /// behind. Without this the client would have to load the full
    /// listing to label its own navigation — the exact cost P5 removes.
    pub fn facets(&self, q: &FacetsQuery) -> AppResult<LibraryFacets> {
        let Some(index) = self.index.as_ref() else {
            return Ok(q.apply_in_memory(&self.scan(true)));
        };
        match self.reconcile(index).and_then(|()| index.facets(q)) {
            Ok(facets) => Ok(facets),
            Err(e) => {
                tracing::warn!("library index facets failed ({e}); scanning instead");
                Ok(q.apply_in_memory(&self.scan(true)))
            }
        }
    }

    /// Bring the index in line with what is on disk *right now*.
    ///
    /// One `read_dir` + `stat` per capture (and per `.meta` record) —
    /// no file contents are read for a capture whose [`Stamp`] is
    /// unchanged, which is the whole saving: an unchanged library costs
    /// stats instead of N JSON parses. Rows whose files are gone are
    /// deleted, so nothing stale can survive into the answer.
    ///
    /// Both directories are walked regardless of `include_trashed`.
    /// The index describes the whole library; what a given caller wants
    /// to *see* is a filter applied at query time. Walking only half of
    /// it would leave the other half unreconciled, and the next caller
    /// asking for trash would get stale rows.
    fn reconcile(&self, index: &LibraryIndex) -> AppResult<()> {
        let captures = self.captures_dir();
        let cached = index.stamps()?;
        let mut seen: HashSet<String> = HashSet::new();
        let mut stale: Vec<(CaptureMeta, Stamp)> = Vec::new();

        collect_dir(&captures, false, &cached, &mut seen, &mut stale);
        collect_dir(
            &captures.join(TRASH_DIRNAME),
            true,
            &cached,
            &mut seen,
            &mut stale,
        );
        self.collect_aux(&cached, &mut seen, &mut stale);

        let gone: Vec<String> = cached
            .keys()
            .filter(|id| !seen.contains(*id))
            .cloned()
            .collect();
        index.put(&stale)?;
        index.remove(&gone)
    }

    /// Mirror the aux catalog's entries into the index.
    ///
    /// The catalog is one file, so it gets one stamp: if every cached
    /// aux row still carries it, the file hasn't moved and the rows
    /// stand. Otherwise it is re-parsed and every entry re-inserted,
    /// which also lets [`Self::reconcile`] prune entries that were
    /// removed from it. An empty catalog re-reads each listing — one
    /// small file, and the alternative is a stamp row for a file with
    /// no rows.
    fn collect_aux(
        &self,
        cached: &HashMap<String, Stamp>,
        seen: &mut HashSet<String>,
        stale: &mut Vec<(CaptureMeta, Stamp)>,
    ) {
        let Some(stamp) = file_stamp(&self.aux_path()) else {
            // No catalog: nothing to keep, and reconcile prunes any
            // rows a deleted one left behind.
            return;
        };
        let fresh: Vec<&String> = cached
            .iter()
            .filter(|(id, cached_stamp)| library::is_aux_id(id) && **cached_stamp == stamp)
            .map(|(id, _)| id)
            .collect();
        if fresh.is_empty() {
            for entry in self.load_aux() {
                seen.insert(entry.id.clone());
                stale.push((entry, stamp));
            }
        } else {
            seen.extend(fresh.into_iter().cloned());
        }
    }

    /// The pre-index listing: walk the directories, read every sidecar,
    /// sort. Kept as the fallback rather than deleted, because a cache
    /// that can fail needs a path that can't.
    fn scan(&self, include_trashed: bool) -> Vec<CaptureMeta> {
        let captures = self.captures_dir();
        let mut out = Vec::new();
        read_dir_metas(&captures, false, &mut out);
        if include_trashed {
            read_dir_metas(&captures.join(TRASH_DIRNAME), true, &mut out);
        }
        // Merge the aux catalog: non-trashed always, trashed only when
        // requested (mirrors the file scan's `.trash` inclusion).
        for entry in self.load_aux() {
            if include_trashed || !entry.trashed {
                out.push(entry);
            }
        }
        // Newest first, ties broken on id — the index orders the same
        // way, and the two paths must not disagree about anything a
        // caller can observe.
        out.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms).then(a.id.cmp(&b.id)));
        out
    }

    /// Throw the cached listing away; the next [`Self::list`] refills
    /// it from disk. Returns the number of rows rebuilt.
    ///
    /// Nothing in normal operation needs this — reconciliation already
    /// keeps the index true — but "rebuildable at any time" is only a
    /// real property if something exercises it.
    pub fn reindex(&self) -> AppResult<u64> {
        let Some(index) = self.index.as_ref() else {
            return Ok(0);
        };
        index.clear()?;
        self.reconcile(index)?;
        index.row_count()
    }

    /// Decode the file at `id`, downscale to `max_width`, return as
    /// a base64 PNG data URI. The frontend's `useThumbnail` caches
    /// + dedupes calls; this method re-decodes on every invocation.
    pub fn thumbnail(&self, id: &str, max_width: u32) -> AppResult<String> {
        library::validate_id(id, &self.captures_dir())?;
        // A video is not a decodable image, so a recording's row is
        // drawn from the poster frame the recorder wrote beside it
        // (ADR 0031). Falling back on *decode failure* rather than
        // branching on extension means a GIF — which `image` decodes
        // natively, first frame and all — keeps using the real file,
        // and a future container needs no change here.
        let source = sidecar::poster_path(Path::new(id))
            .filter(|_| !Self::can_decode_directly(id))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| id.to_string());
        let img = ImageReader::open(&source)
            .map_err(|e| AppError::Library(format!("open: {e}")))?
            .decode()
            .map_err(|e| AppError::Library(format!("decode: {e}")))?;
        let (w, h) = (img.width(), img.height());
        let target_w = max_width.min(w);
        // Aspect-correct height. `f64` math keeps integer overflow
        // out of the picture for unusual aspect ratios.
        let target_h = if w == 0 {
            h
        } else {
            ((h as f64) * (target_w as f64) / (w as f64)).round() as u32
        };
        let resized = if target_w < w {
            img.thumbnail(target_w, target_h)
        } else {
            img
        };
        let mut buf = Vec::new();
        resized
            .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
            .map_err(|e| AppError::Library(format!("encode: {e}")))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        Ok(format!("data:image/png;base64,{b64}"))
    }

    /// Whether the `image` crate can render this file's own pixels.
    ///
    /// GIF can (it decodes the first frame), which is why a recorded GIF
    /// thumbnails from the real file and only true video needs a poster.
    fn can_decode_directly(id: &str) -> bool {
        !matches!(
            library::kind_of(
                Path::new(id)
                    .extension()
                    .and_then(|e| e.to_str())
            ),
            library::CaptureKind::Video
        )
    }

    /// Move `id` from captures/ to captures/.trash/. Returns the
    /// new path (which is the new id). Caller emits
    /// `LIBRARY_UPDATED` after this resolves.
    ///
    /// The capture's sidecars ride along (`services::sidecar`), so a
    /// restore comes back with its provenance and its editable scene
    /// intact rather than as a bare image.
    pub fn delete(&self, id: &str) -> AppResult<String> {
        // Aux entries live in the catalog, not on disk — soft-delete is
        // a flag flip and keeps the same id (unlike a file rename).
        if library::is_aux_id(id) {
            return self.aux_set_trashed(id, true);
        }
        let captures = self.captures_dir();
        library::validate_id(id, &captures)?;
        let trash = captures.join(TRASH_DIRNAME);
        fs::create_dir_all(&trash)
            .map_err(|e| AppError::Library(format!("create trash dir: {e}")))?;
        let src = PathBuf::from(id);
        let name = src
            .file_name()
            .ok_or_else(|| AppError::Library("invalid id: no file name".into()))?;
        let dst = trash.join(name);
        fs::rename(&src, &dst).map_err(|e| AppError::Library(format!("rename: {e}")))?;
        sidecar::relocate(&src, &dst);
        let new_id = dst.to_string_lossy().into_owned();
        self.collections.rekey(id, &new_id);
        Ok(new_id)
    }

    /// Move `id` from captures/.trash/ back to captures/. Returns
    /// the new path (which is the new id). Carries the capture's
    /// sidecars back with it — see [`Self::delete`].
    pub fn restore(&self, id: &str) -> AppResult<String> {
        if library::is_aux_id(id) {
            return self.aux_set_trashed(id, false);
        }
        let captures = self.captures_dir();
        library::validate_id(id, &captures)?;
        let src = PathBuf::from(id);
        let name = src
            .file_name()
            .ok_or_else(|| AppError::Library("invalid id: no file name".into()))?;
        let dst = captures.join(name);
        fs::rename(&src, &dst).map_err(|e| AppError::Library(format!("rename: {e}")))?;
        sidecar::relocate(&src, &dst);
        let new_id = dst.to_string_lossy().into_owned();
        self.collections.rekey(id, &new_id);
        Ok(new_id)
    }

    /// Permanently delete the file at `id` from disk, along with its
    /// sidecars — otherwise emptying the trash would leave orphaned
    /// records behind in the hidden dirs forever.
    pub fn purge(&self, id: &str) -> AppResult<()> {
        if library::is_aux_id(id) {
            self.aux_remove(id)?;
            self.collections.forget(id);
            return Ok(());
        }
        library::validate_id(id, &self.captures_dir())?;
        fs::remove_file(id).map_err(|e| AppError::Library(format!("remove: {e}")))?;
        sidecar::remove(Path::new(id));
        self.collections.forget(id);
        Ok(())
    }

    // -------- Labels (tags + favorite) --------

    /// Apply one label edit to every id, returning how many entries
    /// actually changed.
    ///
    /// Taking a *list* is what makes bulk operations free: starring one
    /// capture and starring a forty-capture selection are the same call,
    /// so the UI never has to fan out N round trips and the backend never
    /// grows a second code path for the plural case.
    ///
    /// An id whose capture has since vanished is skipped rather than
    /// failing the batch — the selection was made against a listing that
    /// another window may have moved on from. An id that escapes the
    /// captures root still fails loudly: that is a malformed request, not
    /// a race.
    pub fn update_labels(&self, ids: &[String], edit: LabelEdit<'_>) -> AppResult<u64> {
        let (aux_ids, file_ids): (Vec<String>, Vec<String>) = ids
            .iter()
            .cloned()
            .partition(|id| library::is_aux_id(id));

        let mut changed = 0;
        for id in &file_ids {
            if self.update_file_labels(id, edit)? {
                changed += 1;
            }
        }
        if !aux_ids.is_empty() {
            changed += self.aux_update_labels(&aux_ids, edit)?;
        }
        Ok(changed)
    }

    /// One file-backed capture's `.labels` record: read, apply, write
    /// back only if something moved. Returns whether it did.
    ///
    /// Skipping the no-op write matters beyond saving a syscall — the
    /// record's mtime is part of the index's stamp, so an idle write
    /// would invalidate the row and cost a rebuild for a change nobody
    /// made.
    fn update_file_labels(&self, id: &str, edit: LabelEdit<'_>) -> AppResult<bool> {
        library::validate_id(id, &self.captures_dir())?;
        let path = Path::new(id);
        if !path.is_file() {
            return Ok(false);
        }
        let existing = sidecar::read_labels(path).unwrap_or_default();
        let mut tags = existing.tags;
        let mut favorite = existing.favorite;
        if !edit.apply(&mut tags, &mut favorite) {
            return Ok(false);
        }
        let file = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        sidecar::write_labels(path, &CaptureLabels::new(&file, tags, favorite))?;
        Ok(true)
    }

    /// The aux catalog's half of [`Self::update_labels`]. Aux entries
    /// have no file to hang a sidecar off, so their labels live on the
    /// row itself inside `history.json` — one load/save for the whole
    /// batch, under the same write lock every other aux mutation takes.
    fn aux_update_labels(&self, ids: &[String], edit: LabelEdit<'_>) -> AppResult<u64> {
        let _guard = self
            .aux_lock
            .lock()
            .map_err(|_| AppError::Library("aux lock poisoned".into()))?;
        let mut entries = self.load_aux();
        let mut changed = 0;
        for entry in entries.iter_mut() {
            if !ids.contains(&entry.id) {
                continue;
            }
            if edit.apply(&mut entry.tags, &mut entry.favorite) {
                changed += 1;
            }
        }
        if changed > 0 {
            self.save_aux(&entries)?;
        }
        Ok(changed)
    }

    /// The collections catalog, shared with the command layer. Held here
    /// so file ops can carry membership across an id change; handed out
    /// so the collection commands don't need a second instance over the
    /// same document.
    pub fn collections(&self) -> &Arc<CollectionsService> {
        &self.collections
    }

    /// Recursive walk of the captures dir; returns `(used_bytes,
    /// total_bytes)` with the total fixed at the display cap. Used
    /// by a future storage-progress footer (not in MVP, but the
    /// IPC + service-side support are scoped in).
    pub fn storage(&self) -> AppResult<StorageInfo> {
        let used = walk_size(&self.captures_dir());
        Ok(StorageInfo {
            used_bytes: used,
            total_bytes: STORAGE_TOTAL_BYTES_CAP,
        })
    }

    // -------- Aux catalog (color / palette / text) --------

    fn aux_path(&self) -> PathBuf {
        self.captures_dir().join(AUX_CATALOG_FILE)
    }

    /// Load the aux catalog. A missing or unparseable file yields an
    /// empty list — the catalog is best-effort metadata; a corrupt file
    /// must not break the whole library listing.
    fn load_aux(&self) -> Vec<CaptureMeta> {
        let Ok(bytes) = fs::read(self.aux_path()) else {
            return Vec::new();
        };
        serde_json::from_slice::<AuxCatalog>(&bytes)
            .map(|c| c.entries)
            .unwrap_or_default()
    }

    fn save_aux(&self, entries: &[CaptureMeta]) -> AppResult<()> {
        fs::create_dir_all(self.captures_dir())
            .map_err(|e| AppError::Library(format!("create captures dir: {e}")))?;
        let json = serde_json::to_vec_pretty(&AuxCatalog {
            entries: entries.to_vec(),
        })
        .map_err(|e| AppError::Library(format!("serialize catalog: {e}")))?;
        fs::write(self.aux_path(), json)
            .map_err(|e| AppError::Library(format!("write catalog: {e}")))
    }

    /// Append an aux entry under the write lock (load → push → save).
    fn aux_add(&self, entry: CaptureMeta) -> AppResult<CaptureMeta> {
        let _guard = self
            .aux_lock
            .lock()
            .map_err(|_| AppError::Library("aux lock poisoned".into()))?;
        let mut entries = self.load_aux();
        entries.push(entry.clone());
        self.save_aux(&entries)?;
        Ok(entry)
    }

    /// Persist a single sampled color (Color-Picker mode).
    pub fn add_color(&self, color: AuxColor) -> AppResult<CaptureMeta> {
        let title = color.hex.clone();
        self.aux_add(CaptureMeta {
            color: Some(color),
            ..CaptureMeta::new(
                new_aux_id("color"),
                title,
                CaptureKind::Color,
                now_ms(),
                0,
                false,
            )
        })
    }

    /// Persist an extracted palette (Palette-Capture mode). Title is the
    /// dominant swatch's hex.
    pub fn add_palette(&self, colors: Vec<AuxColor>) -> AppResult<CaptureMeta> {
        let title = colors
            .first()
            .map(|c| format!("Palette · {}", c.hex))
            .unwrap_or_else(|| "Palette".into());
        self.aux_add(CaptureMeta {
            palette: Some(colors),
            ..CaptureMeta::new(
                new_aux_id("palette"),
                title,
                CaptureKind::Palette,
                now_ms(),
                0,
                false,
            )
        })
    }

    /// Persist recognized text (Grab-Text mode). Title is the first
    /// line / ~48 chars (or "Text" when blank).
    pub fn add_text(&self, text: String) -> AppResult<CaptureMeta> {
        let title = text_title(&text);
        self.aux_add(CaptureMeta {
            text: Some(text),
            ..CaptureMeta::new(
                new_aux_id("text"),
                title,
                CaptureKind::Text,
                now_ms(),
                0,
                false,
            )
        })
    }

    /// Flip an aux entry's `trashed` flag. Returns the (unchanged) id —
    /// aux soft-delete keeps the same id, unlike a file rename.
    fn aux_set_trashed(&self, id: &str, trashed: bool) -> AppResult<String> {
        let _guard = self
            .aux_lock
            .lock()
            .map_err(|_| AppError::Library("aux lock poisoned".into()))?;
        let mut entries = self.load_aux();
        let entry = entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::Library("aux entry not found".into()))?;
        entry.trashed = trashed;
        self.save_aux(&entries)?;
        Ok(id.to_string())
    }

    /// Permanently remove an aux entry from the catalog.
    fn aux_remove(&self, id: &str) -> AppResult<()> {
        let _guard = self
            .aux_lock
            .lock()
            .map_err(|_| AppError::Library("aux lock poisoned".into()))?;
        let mut entries = self.load_aux();
        let before = entries.len();
        entries.retain(|e| e.id != id);
        if entries.len() == before {
            return Err(AppError::Library("aux entry not found".into()));
        }
        self.save_aux(&entries)
    }
}

// -------- Private helpers --------

/// The catalogs that live among the captures but are not captures: the
/// aux entries' `history.json` and the collections document. Both are
/// user data, which is why they sit in the captures dir rather than the
/// app data dir — and both would otherwise list as a stray `.json` row.
fn is_catalog_file(name: &str) -> bool {
    name == AUX_CATALOG_FILE || name == collections_service::CATALOG_FILE_NAME
}

/// Every file in `dir` that counts as a capture, with the filesystem
/// metadata the directory walk already produced.
///
/// Non-recursive by design. Hidden files (`.foo`) and the catalogs
/// are not captures, and the hidden sub-directories (`.trash` and the
/// sidecar families) are never descended into — `.trash` gets its own
/// explicit walk so its rows can be marked trashed.
///
/// The metadata is `Option` because a file can vanish between the
/// `read_dir` and the `stat`; that is a row with zeroes rather than a
/// reason to drop it, matching what the listing did before.
fn capture_files(dir: &Path) -> Vec<(PathBuf, Option<fs::Metadata>)> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') || is_catalog_file(name) {
            continue;
        }
        out.push((path, entry.metadata().ok()));
    }
    out
}

/// One library row for one capture file, reading its `.meta` and
/// `.labels` sidecars.
///
/// The sidecars are strictly additive: a capture without one —
/// everything saved before sidecars shipped — lists exactly as it did
/// before. Notably `created_at_ms` prefers the recorded capture instant
/// over the file's mtime, so editing or copying a capture no longer
/// moves it in the timeline.
///
/// This is the expensive half of a listing (an open + read + parse per
/// capture), which is precisely what the index caches.
fn meta_for_file(path: &Path, fs_meta: Option<&fs::Metadata>, trashed: bool) -> CaptureMeta {
    let id = path.to_string_lossy().into_owned();
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("capture")
        .to_string();
    let size_bytes = fs_meta.map(|m| m.len()).unwrap_or(0);
    let created_at_ms = fs_meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let kind = library::kind_of(path.extension().and_then(|e| e.to_str()));
    let provenance = sidecar::read_metadata(path);
    let labels = sidecar::read_labels(path).unwrap_or_default();
    CaptureMeta {
        created_at_ms: provenance
            .as_ref()
            .map(|p| p.captured_at_ms)
            .unwrap_or(created_at_ms),
        tags: labels.tags,
        favorite: labels.favorite,
        source_app: provenance.as_ref().and_then(|p| p.source_app.clone()),
        source_window: provenance.as_ref().and_then(|p| p.source_window.clone()),
        mode: provenance.as_ref().map(|p| p.mode.clone()),
        width: provenance.as_ref().and_then(|p| p.width),
        height: provenance.as_ref().and_then(|p| p.height),
        monitor: provenance.as_ref().and_then(|p| p.monitor.clone()),
        preset: provenance.as_ref().and_then(|p| p.preset.clone()),
        ..CaptureMeta::new(id, title, kind, created_at_ms, size_bytes, trashed)
    }
}

/// Scan a single directory (non-recursive); push one `CaptureMeta` per
/// file into `out`. The index-free listing path.
fn read_dir_metas(dir: &Path, trashed: bool, out: &mut Vec<CaptureMeta>) {
    for (path, fs_meta) in capture_files(dir) {
        out.push(meta_for_file(&path, fs_meta.as_ref(), trashed));
    }
}

/// Reconcile one directory against `cached`: record every id as seen,
/// and rebuild the row for any capture whose stamp has moved.
///
/// This is where the saving happens — a capture whose stamp matches
/// costs two `stat`s and nothing else, while a changed one pays the
/// same sidecar read the scanning path always paid.
fn collect_dir(
    dir: &Path,
    trashed: bool,
    cached: &HashMap<String, Stamp>,
    seen: &mut HashSet<String>,
    stale: &mut Vec<(CaptureMeta, Stamp)>,
) {
    for (path, fs_meta) in capture_files(dir) {
        let id = path.to_string_lossy().into_owned();
        let stamp = stamp_for(&path, fs_meta.as_ref());
        let unchanged = cached.get(&id) == Some(&stamp);
        seen.insert(id);
        if unchanged {
            continue;
        }
        stale.push((meta_for_file(&path, fs_meta.as_ref(), trashed), stamp));
    }
}

/// The disk state a capture's row is built from: the file's mtime and
/// size, plus the mtime of each record that feeds the row — `.meta`
/// provenance and `.labels`.
///
/// The records are in here because they are half the row: a provenance
/// rewrite, or a tag added, that left the pixels alone would otherwise
/// never reach the cache. An absent record stamps as `0`, which is a
/// stable answer rather than a missing one — a capture that never had
/// labels and one whose last tag was just removed (which *deletes* the
/// record, see `sidecar::write_labels`) compare equal, as they should.
fn stamp_for(path: &Path, fs_meta: Option<&fs::Metadata>) -> Stamp {
    Stamp {
        mtime_ms: fs_meta.and_then(mtime_ms).unwrap_or(0),
        size_bytes: fs_meta.map(|m| clamp_u64(m.len())).unwrap_or(0),
        meta_ms: sidecar_mtime_ms(path, sidecar::METADATA_DIRNAME),
        labels_ms: sidecar_mtime_ms(path, sidecar::LABELS_DIRNAME),
    }
}

fn sidecar_mtime_ms(path: &Path, dirname: &str) -> i64 {
    sidecar::path_for(path, dirname)
        .and_then(|p| fs::metadata(p).ok())
        .and_then(|m| mtime_ms(&m))
        .unwrap_or(0)
}

/// Stamp for a standalone file that has no sidecars of its own — the
/// aux catalog, which carries its entries' labels inline. `None` when
/// the file isn't there at all.
fn file_stamp(path: &Path) -> Option<Stamp> {
    let meta = fs::metadata(path).ok()?;
    Some(Stamp {
        mtime_ms: mtime_ms(&meta).unwrap_or(0),
        size_bytes: clamp_u64(meta.len()),
        ..Stamp::default()
    })
}

fn mtime_ms(meta: &fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
}

fn clamp_u64(n: u64) -> i64 {
    n.min(i64::MAX as u64) as i64
}

/// Recursive byte walker. Symlinks are followed via `fs::read_dir`'s
/// default behaviour (matches legacy).
fn walk_size(dir: &Path) -> u64 {
    let mut total: u64 = 0;
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_file() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        } else if p.is_dir() {
            total += walk_size(&p);
        }
    }
    total
}

/// On-disk wrapper for the aux catalog. The object shape (rather than a
/// bare array) leaves room for a future field without re-shaping the
/// file — the same reason `collections.json` is an object.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct AuxCatalog {
    #[serde(default)]
    entries: Vec<CaptureMeta>,
}

/// Per-process monotonic counter so two aux ids minted in the same
/// millisecond never collide (the lock serializes writes, but ids are
/// minted before locking).
static AUX_SEQ: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Synthetic aux id: `aux_<kind>_<ms>_<seq>`. The `aux_` prefix is what
/// `library::is_aux_id` keys on; a file id (absolute path) never starts
/// with it.
fn new_aux_id(kind: &str) -> String {
    let seq = AUX_SEQ.fetch_add(1, AtomicOrdering::Relaxed);
    format!("aux_{kind}_{}_{seq}", now_ms())
}

/// Library title for a text entry: the first non-empty line, trimmed and
/// truncated to ~48 chars (ellipsized), or "Text" when blank.
fn text_title(text: &str) -> String {
    const MAX: usize = 48;
    let first = text.lines().map(str::trim).find(|l| !l.is_empty());
    match first {
        None => "Text".into(),
        Some(line) if line.chars().count() <= MAX => line.to_string(),
        Some(line) => {
            let head: String = line.chars().take(MAX).collect();
            format!("{head}…")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clippity_domain::library::CaptureKind;
    use crate::settings_service::StaticCapturesDir;
    use std::time::SystemTime;

    /// Build a `LibraryService` rooted at a unique temporary
    /// directory so the tests are hermetic. The guard removes the
    /// temp tree on Drop — matches the `capture_io.rs` pattern (no
    /// `tempfile` / `tempdir` crate dep).
    ///
    /// [`harness`] wires an index in, so the whole suite below asserts
    /// the *cached* listing; [`scanning_harness`] wires none, so the
    /// same assertions can be re-run against the fallback. Anything a
    /// caller can observe has to come out the same either way.
    struct TestHarness {
        root: PathBuf,
        captures: PathBuf,
        service: LibraryService,
    }

    impl Drop for TestHarness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    /// Atomic counter so two parallel tests land in different temp
    /// roots even when their `now_ms()` collides (sub-millisecond
    /// resolution can lose).
    static TEST_NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn harness() -> TestHarness {
        build_harness(true)
    }

    /// The same library with no index — the path taken when the
    /// database can't be opened.
    fn scanning_harness() -> TestHarness {
        build_harness(false)
    }

    fn build_harness(indexed: bool) -> TestHarness {
        let n = TEST_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("clippity-library-test-{}-{n}", now_ms()));
        let captures = root.join("captures");
        fs::create_dir_all(&captures).unwrap();
        let captures_src: Arc<dyn CapturesDirSource> =
            Arc::new(StaticCapturesDir(captures.clone()));
        let db = root.join(crate::library_index::DB_FILE_NAME);
        let service = LibraryService::new(
            captures_src.clone(),
            indexed.then_some(db.as_path()),
            Arc::new(CollectionsService::new(captures_src)),
        );
        TestHarness {
            service,
            captures,
            root,
        }
    }

    fn now_ms() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    }

    fn write_capture(captures_dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        fs::create_dir_all(captures_dir).unwrap();
        let p = captures_dir.join(name);
        fs::write(&p, bytes).unwrap();
        p
    }

    /// Encode a tiny 1×1 PNG so `thumbnail` has a real image to
    /// decode + downscale. Inline pixel rather than depending on a
    /// fixture file makes the test hermetic.
    fn write_tiny_png(captures_dir: &Path, name: &str) -> PathBuf {
        use image::{ImageBuffer, Rgba};
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_pixel(1, 1, Rgba([0, 0, 255, 255]));
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
            .unwrap();
        write_capture(captures_dir, name, &buf)
    }

    // ---------- list ----------

    #[test]
    fn list_empty_dir_returns_empty_vec() {
        let h = harness();
        let items = h.service.list(false).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn list_missing_dir_returns_empty_vec_silently() {
        let h = harness();
        // Remove the captures dir entirely.
        fs::remove_dir(&h.captures).unwrap();
        let items = h.service.list(false).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn list_one_png_returns_one_entry_marked_not_trashed() {
        let h = harness();
        write_capture(&h.captures, "clippity-1.png", b"\x89PNG\r\n\x1a\n");
        let items = h.service.list(false).unwrap();
        assert_eq!(items.len(), 1);
        assert!(!items[0].trashed);
        assert_eq!(items[0].kind, CaptureKind::Image);
        assert_eq!(items[0].title, "clippity-1");
    }

    #[test]
    fn list_skips_hidden_files() {
        let h = harness();
        write_capture(&h.captures, ".hidden", b"x");
        let items = h.service.list(false).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn list_include_trashed_appends_trash_entries() {
        let h = harness();
        write_capture(&h.captures, "active.png", b"\x89PNG");
        write_capture(&h.captures.join(TRASH_DIRNAME), "trashed.png", b"\x89PNG");
        let without_trash = h.service.list(false).unwrap();
        let with_trash = h.service.list(true).unwrap();
        assert_eq!(without_trash.len(), 1);
        assert_eq!(with_trash.len(), 2);
        let trashed_one = with_trash.iter().find(|m| m.trashed).unwrap();
        assert!(trashed_one.id.contains(".trash"));
    }

    #[test]
    fn list_kind_dispatch_matches_extension() {
        let h = harness();
        write_capture(&h.captures, "a.png", b"x");
        write_capture(&h.captures, "b.gif", b"x");
        write_capture(&h.captures, "c.mp4", b"x");
        let items = h.service.list(false).unwrap();
        let kinds: std::collections::HashSet<_> = items.iter().map(|m| m.kind).collect();
        assert!(kinds.contains(&CaptureKind::Image));
        assert!(kinds.contains(&CaptureKind::Gif));
        assert!(kinds.contains(&CaptureKind::Video));
    }

    // ---------- provenance sidecars ----------

    /// Write a `.meta` record for a capture the way a real capture
    /// pipeline would (`capture_io::save_capture_image`), without
    /// pulling a whole capture pipeline into a library test.
    fn write_provenance(path: &Path, app: &str, mode: &str, captured_at_ms: u128) {
        use clippity_domain::metadata::{self, CaptureSource};
        let source = CaptureSource::from_mode(mode)
            .with_window(Some("A Window"), Some(app))
            .with_size(640, 480)
            .with_monitor(Some("Display 2"))
            .with_preset(Some("Docs shot"));
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let record = metadata::build(&source, &name, captured_at_ms);
        sidecar::write_metadata(path, &record).unwrap();
    }

    #[test]
    fn list_folds_provenance_into_the_row() {
        let h = harness();
        let p = write_capture(&h.captures, "Shot.png", b"\x89PNG");
        write_provenance(&p, "Chrome", "Region", 1_700_000_000_000);

        let items = h.service.list(false).unwrap();
        assert_eq!(items.len(), 1, "the record must not list as its own row");
        let row = &items[0];
        assert_eq!(row.source_app.as_deref(), Some("Chrome"));
        assert_eq!(row.source_window.as_deref(), Some("A Window"));
        assert_eq!(row.mode.as_deref(), Some("Region"));
        assert_eq!((row.width, row.height), (Some(640), Some(480)));
        assert_eq!(row.monitor.as_deref(), Some("Display 2"));
        assert_eq!(row.preset.as_deref(), Some("Docs shot"));
    }

    #[test]
    fn list_prefers_the_recorded_capture_instant_over_mtime() {
        // mtime moves whenever a file is touched, copied or restored;
        // the recorded instant is when the capture was actually taken,
        // which is what the library's newest-first order should mean.
        let h = harness();
        let p = write_capture(&h.captures, "Shot.png", b"\x89PNG");
        write_provenance(&p, "Chrome", "Region", 1_700_000_000_000);
        let items = h.service.list(false).unwrap();
        assert_eq!(items[0].created_at_ms, 1_700_000_000_000);
    }

    #[test]
    fn list_leaves_a_capture_without_a_record_exactly_as_before() {
        // Everything captured before sidecars shipped still lists; the
        // provenance columns are simply absent.
        let h = harness();
        write_capture(&h.captures, "Legacy.png", b"\x89PNG");
        let items = h.service.list(false).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source_app, None);
        assert_eq!(items[0].mode, None);
        assert!(items[0].created_at_ms > 0, "falls back to mtime");
    }

    #[test]
    fn a_capture_carries_its_sidecars_through_trash_and_back() {
        let h = harness();
        let p = write_capture(&h.captures, "Round.png", b"\x89PNG");
        write_provenance(&p, "Figma", "Window", 42);
        // A scene document too — trash must not strip the edits either.
        let scene = sidecar::path_for(&p, sidecar::SCENES_DIRNAME).unwrap();
        fs::create_dir_all(scene.parent().unwrap()).unwrap();
        fs::write(&scene, r#"{"version":1}"#).unwrap();

        let trashed = h.service.delete(&p.to_string_lossy()).unwrap();
        let in_trash = h.service.list(true).unwrap();
        let row = in_trash.iter().find(|m| m.trashed).unwrap();
        assert_eq!(row.source_app.as_deref(), Some("Figma"));
        assert!(sidecar::path_for(Path::new(&trashed), sidecar::SCENES_DIRNAME)
            .unwrap()
            .exists());
        // Nothing was left orphaned in the original directory.
        assert!(!scene.exists());

        let restored = h.service.restore(&trashed).unwrap();
        assert_eq!(restored, p.to_string_lossy());
        let back = h.service.list(false).unwrap();
        assert_eq!(back[0].source_app.as_deref(), Some("Figma"));
        assert!(scene.exists(), "the scene came home with the capture");
    }

    #[test]
    fn purging_a_capture_takes_its_records_with_it() {
        let h = harness();
        let p = write_capture(&h.captures, "Gone.png", b"\x89PNG");
        write_provenance(&p, "Chrome", "Region", 7);
        let meta_path = sidecar::path_for(&p, sidecar::METADATA_DIRNAME).unwrap();
        assert!(meta_path.exists());

        h.service.purge(&p.to_string_lossy()).unwrap();
        assert!(!p.exists());
        assert!(
            !meta_path.exists(),
            "an orphaned record would accumulate forever"
        );
    }

    #[test]
    fn a_reused_file_name_does_not_inherit_the_old_captures_record() {
        // The purge above must be what prevents this: a later capture
        // saved under the same name would otherwise adopt stale
        // provenance from the hidden dir.
        let h = harness();
        let p = write_capture(&h.captures, "Reused.png", b"\x89PNG");
        write_provenance(&p, "Chrome", "Region", 7);
        h.service.purge(&p.to_string_lossy()).unwrap();

        write_capture(&h.captures, "Reused.png", b"\x89PNG");
        let items = h.service.list(false).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source_app, None);
    }

    // ---------- thumbnail ----------

    #[test]
    fn thumbnail_returns_png_data_uri_for_valid_image() {
        let h = harness();
        let p = write_tiny_png(&h.captures, "tiny.png");
        let uri = h
            .service
            .thumbnail(&p.to_string_lossy(), 64)
            .expect("thumbnail ok");
        assert!(uri.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn thumbnail_of_a_video_comes_from_its_poster_frame() {
        // An MP4 is not a decodable image, so without the poster the
        // library would have nothing to draw for a recording.
        let h = harness();
        let video = write_capture(&h.captures, "clip.mp4", b"not really an mp4");
        let poster = {
            use image::{ImageBuffer, Rgba};
            let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
                ImageBuffer::from_pixel(4, 4, Rgba([10, 20, 30, 255]));
            let mut png = Vec::new();
            image::DynamicImage::ImageRgba8(img)
                .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
                .unwrap();
            png
        };
        sidecar::write_poster(&video, &poster).expect("poster written");

        let uri = h
            .service
            .thumbnail(&video.to_string_lossy(), 64)
            .expect("thumbnail comes from the poster");
        assert!(uri.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn a_video_without_a_poster_reports_a_decode_failure() {
        // Not silently blank: a recording whose poster went missing is
        // a real problem, and the library's error path already shows a
        // fallback tile for it.
        let h = harness();
        let video = write_capture(&h.captures, "posterless.mp4", b"nope");
        assert!(h.service.thumbnail(&video.to_string_lossy(), 64).is_err());
    }

    #[test]
    fn a_gif_thumbnails_from_the_file_itself_not_a_poster() {
        // `image` decodes a GIF's first frame, so a recorded GIF needs
        // no poster — and must not be diverted to one.
        let h = harness();
        let mut gif = Vec::new();
        {
            use image::codecs::gif::GifEncoder;
            use image::{Delay, Frame, ImageBuffer, Rgba};
            let mut enc = GifEncoder::new(&mut gif);
            let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
                ImageBuffer::from_pixel(4, 4, Rgba([200, 100, 50, 255]));
            enc.encode_frame(Frame::from_parts(
                img,
                0,
                0,
                Delay::from_numer_denom_ms(100, 1),
            ))
            .unwrap();
        }
        let path = write_capture(&h.captures, "loop.gif", &gif);
        let uri = h
            .service
            .thumbnail(&path.to_string_lossy(), 64)
            .expect("gif decodes directly");
        assert!(uri.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn thumbnail_rejects_id_outside_captures_root() {
        let h = harness();
        let err = h.service.thumbnail("/etc/passwd", 64).unwrap_err();
        assert_eq!(err.code(), "library");
    }

    // ---------- delete / restore / purge round-trip ----------

    #[test]
    fn delete_then_restore_round_trips_through_trash() {
        let h = harness();
        let p = write_capture(&h.captures, "round.png", b"x");
        let original = p.to_string_lossy().into_owned();
        let trashed = h.service.delete(&original).expect("delete ok");
        // The file should now be under .trash.
        assert!(trashed.contains(".trash"));
        assert!(!p.exists());
        // Restore moves it back.
        let restored = h.service.restore(&trashed).expect("restore ok");
        assert_eq!(restored, original);
        assert!(PathBuf::from(restored).exists());
    }

    #[test]
    fn purge_removes_file_from_disk() {
        let h = harness();
        let p = write_capture(&h.captures, "purge.png", b"x");
        h.service.purge(&p.to_string_lossy()).expect("purge ok");
        assert!(!p.exists());
    }

    #[test]
    fn delete_rejects_id_outside_captures_root() {
        let h = harness();
        let err = h.service.delete("/etc/passwd").unwrap_err();
        assert_eq!(err.code(), "library");
    }

    // ---------- storage ----------

    #[test]
    fn storage_walks_recursively_and_returns_total_bytes() {
        let h = harness();
        write_capture(&h.captures, "a.png", b"123456");
        write_capture(&h.captures.join(TRASH_DIRNAME), "b.png", b"7890");
        let info = h.service.storage().unwrap();
        assert_eq!(info.used_bytes, 10); // 6 + 4
        assert_eq!(info.total_bytes, STORAGE_TOTAL_BYTES_CAP);
    }

    #[test]
    fn now_ms_is_monotonic_for_test_assertions() {
        // Sanity: just confirms the test helper compiles + runs.
        let _ = now_ms();
    }

    // ---------- aux catalog (color / palette) ----------

    fn sample_color() -> AuxColor {
        AuxColor {
            hex: "#1199FF".into(),
            r: 0x11,
            g: 0x99,
            b: 0xFF,
            proportion: None,
        }
    }

    #[test]
    fn add_color_persists_and_lists() {
        let h = harness();
        let meta = h.service.add_color(sample_color()).unwrap();
        assert!(library::is_aux_id(&meta.id), "got {}", meta.id);
        assert_eq!(meta.kind, CaptureKind::Color);
        let items = h.service.list(false).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, CaptureKind::Color);
        assert_eq!(items[0].color.as_ref().unwrap().hex, "#1199FF");
    }

    #[test]
    fn add_palette_persists_swatches() {
        let h = harness();
        let colors = vec![
            sample_color(),
            AuxColor {
                hex: "#FF0000".into(),
                r: 255,
                g: 0,
                b: 0,
                proportion: Some(0.25),
            },
        ];
        let meta = h.service.add_palette(colors).unwrap();
        assert_eq!(meta.kind, CaptureKind::Palette);
        assert_eq!(meta.palette.as_ref().unwrap().len(), 2);
        // Proportion round-trips through the catalog JSON.
        assert_eq!(meta.palette.as_ref().unwrap()[1].proportion, Some(0.25));
        assert!(meta.title.contains("#1199FF"), "got {}", meta.title);
    }

    #[test]
    fn aux_delete_restore_keeps_id_and_flips_trashed() {
        let h = harness();
        let id = h.service.add_color(sample_color()).unwrap().id;
        // delete → same id, hidden from active list, present in trash.
        let after_delete = h.service.delete(&id).unwrap();
        assert_eq!(after_delete, id, "aux delete keeps the id (no file rename)");
        assert!(h.service.list(false).unwrap().is_empty());
        let trashed = h.service.list(true).unwrap();
        assert_eq!(trashed.len(), 1);
        assert!(trashed[0].trashed);
        // restore → back in the active list, same id.
        let after_restore = h.service.restore(&id).unwrap();
        assert_eq!(after_restore, id);
        assert_eq!(h.service.list(false).unwrap().len(), 1);
    }

    #[test]
    fn aux_purge_removes_from_catalog() {
        let h = harness();
        let id = h.service.add_color(sample_color()).unwrap().id;
        h.service.purge(&id).unwrap();
        assert!(h.service.list(true).unwrap().is_empty());
        // Purging a now-missing aux id errors (not found).
        assert!(h.service.purge(&id).is_err());
    }

    #[test]
    fn list_merges_files_and_aux_entries() {
        let h = harness();
        write_capture(&h.captures, "clippity-1.png", b"\x89PNG");
        h.service.add_color(sample_color()).unwrap();
        let items = h.service.list(false).unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|m| m.kind == CaptureKind::Image));
        assert!(items.iter().any(|m| m.kind == CaptureKind::Color));
    }

    #[test]
    fn aux_catalog_persists_across_service_instances() {
        let h = harness();
        h.service.add_color(sample_color()).unwrap();
        // A fresh service over the same dir reads history.json from disk.
        let captures_src: Arc<dyn CapturesDirSource> =
            Arc::new(StaticCapturesDir(h.captures.clone()));
        let reopened = LibraryService::new(
            captures_src.clone(),
            None,
            Arc::new(CollectionsService::new(captures_src)),
        );
        let items = reopened.list(false).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, CaptureKind::Color);
    }

    #[test]
    fn add_text_persists_with_first_line_title() {
        let h = harness();
        let meta = h
            .service
            .add_text("Hello world\nsecond line".into())
            .unwrap();
        assert_eq!(meta.kind, CaptureKind::Text);
        assert_eq!(meta.title, "Hello world");
        assert_eq!(meta.text.as_deref(), Some("Hello world\nsecond line"));
        assert!(library::is_aux_id(&meta.id));
        assert!(h
            .service
            .list(false)
            .unwrap()
            .iter()
            .any(|m| m.kind == CaptureKind::Text));
    }

    #[test]
    fn add_text_blank_falls_back_to_text_title() {
        let h = harness();
        let meta = h.service.add_text("   \n  ".into()).unwrap();
        assert_eq!(meta.title, "Text");
    }

    #[test]
    fn add_text_ellipsizes_a_long_title() {
        let h = harness();
        let meta = h.service.add_text("x".repeat(60)).unwrap();
        // 48 kept chars + the ellipsis.
        assert_eq!(meta.title.chars().count(), 49);
        assert!(meta.title.ends_with('…'));
    }

    // ---------- labels (tags + favorite) ----------

    fn tags(items: &[CaptureMeta], id: &str) -> Vec<String> {
        items
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.tags.clone())
            .unwrap_or_default()
    }

    #[test]
    fn tagging_a_capture_shows_up_in_the_next_listing() {
        let h = harness();
        let p = write_capture(&h.captures, "Shot.png", b"\x89PNG");
        let id = p.to_string_lossy().into_owned();
        assert_eq!(h.service.list(false).unwrap()[0].tags.len(), 0);

        let changed = h
            .service
            .update_labels(std::slice::from_ref(&id), LabelEdit::AddTags(&["Bug".into()]))
            .unwrap();
        assert_eq!(changed, 1);
        assert_eq!(tags(&h.service.list(false).unwrap(), &id), vec!["Bug"]);
    }

    #[test]
    fn favoriting_a_capture_shows_up_in_the_next_listing() {
        let h = harness();
        let p = write_capture(&h.captures, "Shot.png", b"\x89PNG");
        let id = p.to_string_lossy().into_owned();
        h.service
            .update_labels(&[id], LabelEdit::Favorite(true))
            .unwrap();
        assert!(h.service.list(false).unwrap()[0].favorite);
    }

    #[test]
    fn removing_the_last_label_leaves_no_record_behind() {
        // ...and the listing has to agree: an un-starred capture is
        // indistinguishable from one that was never starred.
        let h = harness();
        let p = write_capture(&h.captures, "Shot.png", b"\x89PNG");
        let id = p.to_string_lossy().into_owned();
        h.service
            .update_labels(std::slice::from_ref(&id), LabelEdit::Favorite(true))
            .unwrap();
        h.service
            .update_labels(&[id], LabelEdit::Favorite(false))
            .unwrap();
        assert!(!h.service.list(false).unwrap()[0].favorite);
        assert!(sidecar::read_labels(&p).is_none());
    }

    #[test]
    fn a_no_op_edit_changes_nothing_and_says_so() {
        let h = harness();
        let p = write_capture(&h.captures, "Shot.png", b"\x89PNG");
        let id = p.to_string_lossy().into_owned();
        h.service
            .update_labels(std::slice::from_ref(&id), LabelEdit::AddTags(&["bug".into()]))
            .unwrap();
        let changed = h
            .service
            .update_labels(&[id], LabelEdit::AddTags(&["BUG".into()]))
            .unwrap();
        assert_eq!(changed, 0, "a tag already carried is not a change");
    }

    #[test]
    fn one_edit_covers_a_whole_selection() {
        // Bulk is the same call as single — that is the reason the API
        // takes a list rather than the UI fanning out N round trips.
        let h = harness();
        let ids: Vec<String> = ["A.png", "B.png", "C.png"]
            .iter()
            .map(|n| {
                write_capture(&h.captures, n, b"\x89PNG")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        let changed = h
            .service
            .update_labels(&ids, LabelEdit::AddTags(&["sprint-12".into()]))
            .unwrap();
        assert_eq!(changed, 3);
        let items = h.service.list(false).unwrap();
        assert!(items.iter().all(|m| m.tags == vec!["sprint-12".to_string()]));
    }

    #[test]
    fn setting_tags_replaces_them_wholesale() {
        let h = harness();
        let p = write_capture(&h.captures, "Shot.png", b"\x89PNG");
        let id = p.to_string_lossy().into_owned();
        h.service
            .update_labels(std::slice::from_ref(&id), LabelEdit::AddTags(&["old".into()]))
            .unwrap();
        h.service
            .update_labels(std::slice::from_ref(&id), LabelEdit::SetTags(&["new".into()]))
            .unwrap();
        assert_eq!(tags(&h.service.list(false).unwrap(), &id), vec!["new"]);
        h.service
            .update_labels(std::slice::from_ref(&id), LabelEdit::RemoveTags(&["NEW".into()]))
            .unwrap();
        assert!(tags(&h.service.list(false).unwrap(), &id).is_empty());
    }

    #[test]
    fn labels_ride_through_the_trash_and_back() {
        let h = harness();
        let p = write_capture(&h.captures, "Round.png", b"\x89PNG");
        let id = p.to_string_lossy().into_owned();
        h.service
            .update_labels(std::slice::from_ref(&id), LabelEdit::AddTags(&["keep".into()]))
            .unwrap();
        h.service
            .update_labels(std::slice::from_ref(&id), LabelEdit::Favorite(true))
            .unwrap();

        let trashed = h.service.delete(&id).unwrap();
        let in_trash = h.service.list(true).unwrap();
        let row = in_trash.iter().find(|m| m.trashed).unwrap();
        assert_eq!(row.tags, vec!["keep".to_string()]);
        assert!(row.favorite);

        h.service.restore(&trashed).unwrap();
        assert_eq!(tags(&h.service.list(false).unwrap(), &id), vec!["keep"]);
    }

    #[test]
    fn labelling_an_id_outside_the_captures_root_is_refused() {
        let h = harness();
        let err = h
            .service
            .update_labels(&["/etc/passwd".into()], LabelEdit::Favorite(true))
            .unwrap_err();
        assert_eq!(err.code(), "library");
    }

    #[test]
    fn labelling_a_capture_that_has_since_vanished_is_skipped_not_fatal() {
        // A selection is made against a listing another window may have
        // moved on from; one missing file must not fail the batch.
        let h = harness();
        let present = write_capture(&h.captures, "Here.png", b"\x89PNG")
            .to_string_lossy()
            .into_owned();
        let absent = h.captures.join("Gone.png").to_string_lossy().into_owned();
        let changed = h
            .service
            .update_labels(&[present, absent], LabelEdit::Favorite(true))
            .unwrap();
        assert_eq!(changed, 1);
    }

    #[test]
    fn aux_entries_carry_labels_on_their_catalog_row() {
        // No file, no sidecar — the labels live on the row itself, and
        // the caller cannot tell the difference.
        let h = harness();
        let id = h.service.add_color(sample_color()).unwrap().id;
        let changed = h
            .service
            .update_labels(std::slice::from_ref(&id), LabelEdit::AddTags(&["brand".into()]))
            .unwrap();
        assert_eq!(changed, 1);
        h.service
            .update_labels(std::slice::from_ref(&id), LabelEdit::Favorite(true))
            .unwrap();

        let items = h.service.list(false).unwrap();
        assert_eq!(tags(&items, &id), vec!["brand"]);
        assert!(items[0].favorite);
        // ...and they survive a delete/restore round trip, which for an
        // aux entry is a flag flip on the same row.
        h.service.delete(&id).unwrap();
        h.service.restore(&id).unwrap();
        assert_eq!(tags(&h.service.list(false).unwrap(), &id), vec!["brand"]);
    }

    #[test]
    fn a_mixed_selection_labels_files_and_aux_entries_together() {
        let h = harness();
        let file = write_capture(&h.captures, "Shot.png", b"\x89PNG")
            .to_string_lossy()
            .into_owned();
        let aux = h.service.add_color(sample_color()).unwrap().id;
        let changed = h
            .service
            .update_labels(&[file, aux], LabelEdit::Favorite(true))
            .unwrap();
        assert_eq!(changed, 2);
        assert!(h.service.list(false).unwrap().iter().all(|m| m.favorite));
    }

    // ---------- collections at the file-op choke points ----------

    #[test]
    fn the_collections_document_is_not_a_capture() {
        // It lives among the captures because it is user data; it must
        // not list as a stray row for it.
        let h = harness();
        h.service.collections().create("Docs").unwrap();
        assert!(h.service.list(true).unwrap().is_empty());
    }

    #[test]
    fn a_trashed_capture_keeps_its_place_in_a_collection() {
        let h = harness();
        let p = write_capture(&h.captures, "Member.png", b"\x89PNG");
        let id = p.to_string_lossy().into_owned();
        let collection = h.service.collections().create("Walkthrough").unwrap();
        h.service
            .collections()
            .add_members(&collection.id, std::slice::from_ref(&id))
            .unwrap();

        let trashed = h.service.delete(&id).unwrap();
        assert_eq!(
            h.service.collections().list()[0].members,
            vec![trashed.clone()],
            "membership follows the capture into the trash"
        );

        h.service.restore(&trashed).unwrap();
        assert_eq!(h.service.collections().list()[0].members, vec![id]);
    }

    #[test]
    fn purging_a_capture_drops_it_from_every_collection() {
        let h = harness();
        let p = write_capture(&h.captures, "Doomed.png", b"\x89PNG");
        let id = p.to_string_lossy().into_owned();
        let collection = h.service.collections().create("C").unwrap();
        h.service
            .collections()
            .add_members(&collection.id, std::slice::from_ref(&id))
            .unwrap();
        h.service.purge(&id).unwrap();
        assert!(h.service.collections().list()[0].members.is_empty());
    }

    #[test]
    fn trashing_a_capture_no_collection_holds_is_still_fine() {
        let h = harness();
        let p = write_capture(&h.captures, "Loner.png", b"\x89PNG");
        h.service.delete(&p.to_string_lossy()).unwrap();
        assert!(h.service.collections().list().is_empty());
    }

    // ---------- the index as a cache ----------
    //
    // Every test above already runs through the index (see `harness`).
    // These pin the properties that make that safe: the two listing
    // paths agree, the cache follows disk, and nothing stale survives.

    /// Both listings, as `(id, created_at_ms, trashed)` triples — the
    /// observable shape a caller sorts and renders.
    fn shape(items: &[CaptureMeta]) -> Vec<(String, u128, bool)> {
        items
            .iter()
            .map(|m| (m.id.clone(), m.created_at_ms, m.trashed))
            .collect()
    }

    #[test]
    fn the_indexed_and_scanning_listings_agree() {
        // The fallback has to be indistinguishable, or losing the cache
        // would quietly change what the library shows.
        let indexed = harness();
        let scanned = scanning_harness();
        for h in [&indexed, &scanned] {
            let p = write_capture(&h.captures, "Shot.png", b"\x89PNG");
            write_provenance(&p, "Chrome", "Region", 1_700_000_000_000);
            write_capture(&h.captures, "Plain.png", b"\x89PNG");
            write_capture(&h.captures.join(TRASH_DIRNAME), "Old.png", b"\x89PNG");
            h.service.add_color(sample_color()).unwrap();
        }
        for include_trashed in [false, true] {
            let a = indexed.service.list(include_trashed).unwrap();
            let b = scanned.service.list(include_trashed).unwrap();
            // Ids differ only by temp root; compare the rest positionally.
            assert_eq!(a.len(), b.len(), "trashed={include_trashed}");
            for (x, y) in a.iter().zip(b.iter()) {
                assert_eq!(x.title, y.title);
                assert_eq!(x.kind, y.kind);
                assert_eq!(x.trashed, y.trashed);
                assert_eq!(x.source_app, y.source_app);
                assert_eq!(x.mode, y.mode);
                assert_eq!(x.color, y.color);
                // Only a recorded instant is comparable across the two
                // harnesses — the rest of the rows date from their own
                // file's mtime, and the two trees were written
                // milliseconds apart.
                if x.mode.is_some() {
                    assert_eq!(x.created_at_ms, y.created_at_ms);
                }
            }
        }
    }

    #[test]
    fn a_new_capture_appears_in_the_next_listing() {
        let h = harness();
        assert!(h.service.list(false).unwrap().is_empty());
        write_capture(&h.captures, "Fresh.png", b"\x89PNG");
        let items = h.service.list(false).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Fresh");
    }

    #[test]
    fn a_capture_deleted_behind_our_back_leaves_the_listing() {
        // The cache must never outlive its file: someone deleting a
        // capture in Explorer is the ordinary case, not an edge one.
        let h = harness();
        let p = write_capture(&h.captures, "Doomed.png", b"\x89PNG");
        assert_eq!(h.service.list(false).unwrap().len(), 1);
        fs::remove_file(&p).unwrap();
        assert!(h.service.list(false).unwrap().is_empty());
    }

    #[test]
    fn rewriting_a_captures_record_refreshes_its_row() {
        // The stamp covers the `.meta` sidecar as well as the capture,
        // so provenance rewritten on its own still reaches the cache.
        let h = harness();
        let p = write_capture(&h.captures, "Shot.png", b"\x89PNG");
        write_provenance(&p, "Chrome", "Region", 1_000);
        assert_eq!(
            h.service.list(false).unwrap()[0].source_app.as_deref(),
            Some("Chrome")
        );
        write_provenance(&p, "Figma", "Window", 2_000);
        let row = &h.service.list(false).unwrap()[0];
        assert_eq!(row.source_app.as_deref(), Some("Figma"));
        assert_eq!(row.mode.as_deref(), Some("Window"));
        assert_eq!(row.created_at_ms, 2_000);
    }

    #[test]
    fn trashing_a_capture_moves_its_row_rather_than_duplicating_it() {
        // A trash move changes the id (the path *is* the id), so the
        // old row has to be pruned or the capture would list twice.
        let h = harness();
        let p = write_capture(&h.captures, "Round.png", b"\x89PNG");
        h.service.list(true).unwrap();
        let trashed = h.service.delete(&p.to_string_lossy()).unwrap();

        let all = h.service.list(true).unwrap();
        assert_eq!(all.len(), 1, "one capture, one row");
        assert_eq!(all[0].id, trashed);
        assert!(all[0].trashed);
        assert!(h.service.list(false).unwrap().is_empty());

        h.service.restore(&trashed).unwrap();
        let back = h.service.list(true).unwrap();
        assert_eq!(back.len(), 1);
        assert!(!back[0].trashed);
    }

    #[test]
    fn the_index_covers_trash_even_when_the_caller_did_not_ask_for_it() {
        // Reconciliation walks the whole library regardless; asking for
        // the active list must not leave trash rows stale.
        let h = harness();
        let p = write_capture(&h.captures, "Round.png", b"\x89PNG");
        let trashed = h.service.delete(&p.to_string_lossy()).unwrap();
        // Only ever ask for the active list...
        h.service.list(false).unwrap();
        fs::remove_file(&trashed).unwrap();
        h.service.list(false).unwrap();
        // ...and the trashed row is still correct when someone looks.
        assert!(h.service.list(true).unwrap().is_empty());
    }

    #[test]
    fn purging_an_aux_entry_prunes_its_row() {
        // The aux catalog is one file with one stamp; a rewrite has to
        // re-derive every row from it, including the ones now missing.
        let h = harness();
        let id = h.service.add_color(sample_color()).unwrap().id;
        assert_eq!(h.service.list(true).unwrap().len(), 1);
        h.service.purge(&id).unwrap();
        assert!(h.service.list(true).unwrap().is_empty());
    }

    #[test]
    fn reindex_rebuilds_the_same_listing() {
        let h = harness();
        let p = write_capture(&h.captures, "Shot.png", b"\x89PNG");
        write_provenance(&p, "Chrome", "Region", 1_700_000_000_000);
        write_capture(&h.captures.join(TRASH_DIRNAME), "Old.png", b"\x89PNG");
        h.service.add_color(sample_color()).unwrap();
        let before = h.service.list(true).unwrap();

        let rows = h.service.reindex().unwrap();
        assert_eq!(rows as usize, before.len());
        assert_eq!(shape(&h.service.list(true).unwrap()), shape(&before));
    }

    #[test]
    fn reindex_without_an_index_is_a_no_op() {
        let h = scanning_harness();
        write_capture(&h.captures, "Shot.png", b"\x89PNG");
        assert_eq!(h.service.reindex().unwrap(), 0);
        // …and the library still lists, because it never needed one.
        assert_eq!(h.service.list(false).unwrap().len(), 1);
    }

    #[test]
    fn the_cache_survives_a_restart() {
        let h = harness();
        write_capture(&h.captures, "Shot.png", b"\x89PNG");
        let first = h.service.list(false).unwrap();

        // A second service over the same captures dir *and* the same
        // database — what relaunching the app looks like.
        let db = h.root.join(crate::library_index::DB_FILE_NAME);
        let captures_src: Arc<dyn CapturesDirSource> =
            Arc::new(StaticCapturesDir(h.captures.clone()));
        let reopened = LibraryService::new(
            captures_src.clone(),
            Some(db.as_path()),
            Arc::new(CollectionsService::new(captures_src)),
        );
        assert_eq!(shape(&reopened.list(false).unwrap()), shape(&first));
    }
}
