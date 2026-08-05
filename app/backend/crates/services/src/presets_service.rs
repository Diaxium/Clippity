//! Capture-presets persistence — JSON file + in-memory snapshot behind a
//! `RwLock`, mirroring `settings_service`.
//!
//! Persistence:
//! - File: `<paths.data>/presets.json` (a pretty-printed array).
//! - Read at construction (`load`); ignored if absent or malformed.
//! - Rewritten on every mutation.
//!
//! Every `create` / `update` / `delete` persists the full list and emits
//! `clippity://presets/changed` with it, so the tray's Presets section
//! and the dashboard manager stay in sync without polling. See
//! [ADR 0004](../../docs/decisions/0004-capture-presets.md).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock, RwLockWriteGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

use clippity_domain::preset::{self, CapturePreset, PresetInput};
use clippity_infra::error::{AppError, AppResult};
use clippity_infra::events;
use clippity_infra::paths::AppPaths;

/// Disambiguates ids minted within the same millisecond.
static PRESET_NONCE: AtomicU64 = AtomicU64::new(0);

pub struct PresetsService {
    file: PathBuf,
    state: RwLock<Vec<CapturePreset>>,
}

impl PresetsService {
    /// Read presets from disk (silent empty-fallback on missing /
    /// malformed file).
    pub fn load(paths: Arc<AppPaths>) -> AppResult<Self> {
        let file = paths.data.join("presets.json");
        let state = read_or_log(&file);
        Ok(Self {
            file,
            state: RwLock::new(state),
        })
    }

    /// Snapshot the current presets (newest-last insertion order).
    pub fn list(&self) -> Vec<CapturePreset> {
        self.state.read().map(|g| g.clone()).unwrap_or_default()
    }

    /// Validate + mint an id, append, persist, emit changed.
    pub fn create(&self, app: &AppHandle, input: PresetInput) -> AppResult<CapturePreset> {
        let name =
            preset::validate_name(&input.name).map_err(|e| AppError::Presets(e.to_string()))?;
        let preset = CapturePreset {
            id: mint_id(),
            name,
            request: input.request,
            output: input.output,
        };
        {
            let mut guard = self.write_guard()?;
            guard.push(preset.clone());
            persist(&self.file, &guard)?;
        }
        self.emit_changed(app)?;
        Ok(preset)
    }

    /// Replace the preset with the same id. Validates the (trimmed)
    /// name; errors if no preset with that id exists.
    pub fn update(&self, app: &AppHandle, mut preset: CapturePreset) -> AppResult<CapturePreset> {
        preset.name =
            preset::validate_name(&preset.name).map_err(|e| AppError::Presets(e.to_string()))?;
        {
            let mut guard = self.write_guard()?;
            let slot = guard
                .iter_mut()
                .find(|p| p.id == preset.id)
                .ok_or_else(|| AppError::Presets(format!("no preset with id {}", preset.id)))?;
            *slot = preset.clone();
            persist(&self.file, &guard)?;
        }
        self.emit_changed(app)?;
        Ok(preset)
    }

    /// Remove the preset with `id`. Idempotent: a no-op (no persist, no
    /// event) if nothing matched.
    pub fn delete(&self, app: &AppHandle, id: &str) -> AppResult<()> {
        let changed = {
            let mut guard = self.write_guard()?;
            let before = guard.len();
            guard.retain(|p| p.id != id);
            let changed = guard.len() != before;
            if changed {
                persist(&self.file, &guard)?;
            }
            changed
        };
        if changed {
            self.emit_changed(app)?;
        }
        Ok(())
    }

    fn write_guard(&self) -> AppResult<RwLockWriteGuard<'_, Vec<CapturePreset>>> {
        self.state
            .write()
            .map_err(|_| AppError::Presets("presets lock poisoned".into()))
    }

    fn emit_changed(&self, app: &AppHandle) -> AppResult<()> {
        events::emit(app, events::names::PRESETS_CHANGED, self.list())
    }
}

/// Millisecond epoch + a process-local nonce so two presets minted in
/// the same millisecond still get distinct ids.
fn mint_id() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = PRESET_NONCE.fetch_add(1, Ordering::Relaxed);
    format!("preset_{ts}_{n}")
}

fn read_file(path: &Path) -> Option<Vec<CapturePreset>> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Load presets from disk, falling back to empty — but log why. A
/// missing file is the expected first-run case (`debug`); a present-
/// but-unparseable file means the user's saved presets just vanished,
/// which warrants a `warn`. The on-disk file is left intact until the
/// next mutation rewrites it, so it can be recovered.
fn read_or_log(path: &Path) -> Vec<CapturePreset> {
    if !path.exists() {
        tracing::debug!(
            path = %path.display(),
            "no presets file — starting empty (fresh install)"
        );
        return Vec::new();
    }
    read_file(path).unwrap_or_else(|| {
        tracing::warn!(
            path = %path.display(),
            "presets file could not be read or parsed — starting empty; the \
             file is left untouched until the next change so it can be recovered"
        );
        Vec::new()
    })
}

fn persist(path: &Path, presets: &[CapturePreset]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(presets)?;
    fs::write(path, json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clippity_domain::capture::{CaptureKind, CaptureRequest, CaptureToggles};
    use clippity_domain::preset::{PresetOutput, PresetRequest};

    fn sample(name: &str, id: &str) -> CapturePreset {
        CapturePreset {
            id: id.into(),
            name: name.into(),
            request: PresetRequest::Capture(CaptureRequest {
                kind: CaptureKind::Fullscreen,
                custom_mode: None,
                toggles: CaptureToggles {
                    preview: false,
                    clipboard: true,
                    cursor: false,
                    enhance: false,
                },
                delay: None,
                effect: None,
                share: None,
                output_dir: None,
                preset: None,
            }),
            output: PresetOutput {
                open_editor: true,
                save_dir: None,
            },
        }
    }

    #[test]
    fn read_missing_file_is_none() {
        let path = std::env::temp_dir().join("clippity-presets-missing-xyz.json");
        let _ = fs::remove_file(&path);
        assert!(read_file(&path).is_none());
    }

    #[test]
    fn persist_then_read_round_trips() {
        let dir = std::env::temp_dir().join(format!("clippity-presets-{}", mint_id()));
        let file = dir.join("presets.json");
        let presets = vec![sample("One", "preset_a"), sample("Two", "preset_b")];

        persist(&file, &presets).expect("persist ok");
        let back = read_file(&file).expect("read back");

        assert_eq!(back.len(), 2);
        assert_eq!(back[0].name, "One");
        assert_eq!(back[1].id, "preset_b");
        assert!(back[0].output.open_editor);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_malformed_file_is_none() {
        let dir = std::env::temp_dir().join(format!("clippity-presets-bad-{}", mint_id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("presets.json");
        fs::write(&file, "not json at all").unwrap();
        assert!(read_file(&file).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mint_id_is_unique_and_prefixed() {
        let a = mint_id();
        let b = mint_id();
        assert!(a.starts_with("preset_"), "got {a}");
        assert_ne!(a, b);
    }

    // The AppHandle-taking CRUD methods (create/update/delete) are
    // covered by the manual gate — they only add validate + emit on top
    // of the persist/read helpers exercised above, matching the
    // settings_service test split.
}
