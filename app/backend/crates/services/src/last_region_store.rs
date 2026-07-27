//! Last-region persistence — the "capture that same spot again" memory.
//!
//! Persistence:
//! - File: `<paths.data>/last-region.json` (a single pretty-printed
//!   [`LastRegion`] object).
//! - Read at construction (`load`); ignored if absent or malformed, so a
//!   corrupt file costs the user their last region and nothing else.
//! - Rewritten whenever a rectangular capture is finalized.
//!
//! Deliberately NOT part of `settings.json`. Two reasons: this is app
//! state rather than user-expressed preference, and `settings_service`
//! broadcasts `clippity://settings/changed` on every write — routing a
//! per-capture write through it would fire a settings-changed event at
//! every window on every capture.
//!
//! Writes are best-effort. A capture that succeeded must not be reported
//! as failed because we could not remember its rect afterwards, so
//! `remember` logs and swallows I/O errors rather than propagating them.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use clippity_domain::overlay::{LastRegion, Region};
use clippity_infra::error::AppResult;
use clippity_infra::paths::AppPaths;

pub struct LastRegionStore {
    file: PathBuf,
    state: RwLock<Option<LastRegion>>,
}

impl LastRegionStore {
    /// Read the remembered region from disk (silent `None` fallback on a
    /// missing / malformed file).
    pub fn load(paths: Arc<AppPaths>) -> AppResult<Self> {
        Ok(Self::at(paths.data.join("last-region.json")))
    }

    /// Back the store with an explicit file. Used by `load`, and by
    /// tests that need a store without an `AppPaths`.
    pub fn at(file: PathBuf) -> Self {
        let state = read_file(&file);
        Self {
            file,
            state: RwLock::new(state),
        }
    }

    /// The remembered region, if any. Raw — callers resolve it against
    /// the live canvas via `domain::overlay::resolve_last_region`.
    pub fn get(&self) -> Option<LastRegion> {
        self.state.read().ok().and_then(|g| *g)
    }

    /// Record `region` as the last rectangular selection, against the
    /// canvas dimensions it was selected on. Best-effort: a failed write
    /// leaves the in-memory value updated and logs.
    pub fn remember(&self, region: Region, canvas_width: u32, canvas_height: u32) {
        let last = LastRegion {
            region,
            canvas_width,
            canvas_height,
        };
        if let Ok(mut guard) = self.state.write() {
            *guard = Some(last);
        }
        if let Err(e) = persist(&self.file, &last) {
            tracing::warn!(
                path = %self.file.display(),
                "failed to persist last region: {e}"
            );
        }
    }
}

fn read_file(path: &Path) -> Option<LastRegion> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn persist(path: &Path, last: &LastRegion) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(last)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    fs::write(path, json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("clippity-last-region-{name}.json"))
    }

    fn sample() -> LastRegion {
        LastRegion {
            region: Region {
                x: 100,
                y: 200,
                width: 640,
                height: 480,
            },
            canvas_width: 3840,
            canvas_height: 1080,
        }
    }

    #[test]
    fn missing_file_reads_as_none() {
        let path = temp_path("missing");
        let _ = fs::remove_file(&path);
        assert!(read_file(&path).is_none());
    }

    #[test]
    fn malformed_file_reads_as_none() {
        let path = temp_path("malformed");
        fs::write(&path, "{ not json").unwrap();
        assert!(read_file(&path).is_none());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn round_trips_through_disk() {
        let path = temp_path("roundtrip");
        let _ = fs::remove_file(&path);
        persist(&path, &sample()).unwrap();
        assert_eq!(read_file(&path), Some(sample()));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn remember_overwrites_the_previous_region() {
        let path = temp_path("overwrite");
        let _ = fs::remove_file(&path);
        let store = LastRegionStore::at(path.clone());
        store.remember(sample().region, 3840, 1080);
        assert_eq!(store.get(), Some(sample()));

        let next = Region {
            x: 0,
            y: 0,
            width: 32,
            height: 32,
        };
        store.remember(next, 1920, 1080);
        let got = store.get().expect("region remembered");
        assert_eq!(got.region, next);
        assert_eq!(got.canvas_width, 1920);
        // The on-disk copy tracks the in-memory one.
        assert_eq!(read_file(&path), Some(got));
        let _ = fs::remove_file(&path);
    }
}
