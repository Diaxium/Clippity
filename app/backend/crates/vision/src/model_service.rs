//! On-device AI model manager — download / install / remove the ONNX
//! artifacts the vision features run on.
//!
//! Layout: every model is a single `.onnx` file in `AppPaths.models`
//! (`<cache>/Clippity/models/<id>.onnx`). "Installed" therefore means
//! "file exists with exactly the registry's expected byte size" — no
//! separate manifest to drift out of sync with the filesystem.
//!
//! Downloads stream to `<id>.onnx.part` and are renamed into place only
//! after the size check passes, so a crashed/cancelled fetch can never
//! masquerade as an installed model. Each download runs on its own
//! thread and reports through two events:
//!
//! - `clippity://models/progress` — throttled `{id, downloaded, total}`
//!   ticks for the Models settings page progress bar.
//! - `clippity://models/changed`  — full `Vec<ModelInfo>` after any
//!   status transition (start / done / error / cancel / remove), so
//!   every window converges on the same view without polling.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use clippity_domain::models::{
    self, ModelArtifact, ModelInfo, ModelPhase, ModelProgress, ModelSpec, ObjectModelReadiness,
    ReadinessStatus, ReleaseCheck, ReleaseSource,
};
use clippity_domain::settings::ModelsSettings;
use clippity_infra::error::{AppError, AppResult};
use clippity_infra::events;
use clippity_infra::paths::AppPaths;

/// Read-buffer size for the download stream. 64 KiB keeps syscall
/// overhead low without hogging memory.
const CHUNK: usize = 64 * 1024;

/// Minimum bytes between two progress emits — caps the event rate so a
/// fast connection doesn't flood the IPC channel.
const PROGRESS_STRIDE: u64 = 512 * 1024;

/// How long a fetched GitHub release stays cached before the next
/// `check_updates` re-queries. Long enough that opening the Models page a
/// few times in a row costs one request (GitHub allows 60/hr unauthed),
/// short enough to notice a fresh publish within minutes. The disk-derived
/// "installed?/up-to-date?" flags are recomputed on every call regardless,
/// so a self-update is reflected immediately — only the network half is
/// cached.
const RELEASE_CACHE_TTL: Duration = Duration::from_secs(300);

/// User-Agent sent on the GitHub API call. GitHub rejects API requests
/// without one (HTTP 403), so this is mandatory, not cosmetic.
const GH_USER_AGENT: &str = "Clippity-ModelManager";

/// Live download bookkeeping, shared with the worker thread.
struct DownloadHandle {
    downloaded: Arc<AtomicU64>,
    total: u64,
    cancel: Arc<AtomicBool>,
}

/// Shared mutable state — split from the service so worker threads can
/// hold it without holding the service itself.
#[derive(Default)]
struct Registry {
    /// In-flight downloads by model id.
    downloads: HashMap<String, DownloadHandle>,
    /// Last download error by model id — cleared when a new download
    /// starts. Purely informational (drives the `error` phase chip).
    errors: HashMap<String, String>,
}

/// What we install for a model, recorded beside its artifacts as
/// `<id>.model.json`. The integrity model is "file exists at its expected
/// size", and a self-update writes bytes whose size the compile-time
/// registry doesn't know — so without this record the offline phase logic
/// would read a freshly self-updated model as *not installed*. The
/// manifest pins the actually-fetched sizes (so they count as installed)
/// and the release tag (so "which version do I have" is exact, not
/// inferred). Written on every successful install; deleted on remove.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct InstalledManifest {
    /// Release tag the bytes came from (`onnx-v3`), or a registry version
    /// label (`v2`) for the pinned, non-GitHub case.
    tag: String,
    /// Exact size of each installed artifact file, by on-disk file name.
    sizes: HashMap<String, u64>,
}

/// The network half of a release check, cached for [`RELEASE_CACHE_TTL`].
/// Holds everything from the GitHub response; the disk-derived flags
/// (installed / up-to-date) are layered on fresh per call.
#[derive(Clone)]
struct CachedRelease {
    fetched: Instant,
    tag: String,
    published_at: String,
    html_url: String,
    /// Detector (and typer, for typed models) resolved to canonical
    /// on-disk file names + the release's download URL and size. Empty
    /// when the release's assets didn't match this model's matchers.
    artifacts: Vec<ModelArtifact>,
    /// Whether `artifacts` fully covers the model (detector + any typer) —
    /// gates the live update action.
    updatable: bool,
}

pub struct ModelService {
    models_dir: PathBuf,
    state: Arc<Mutex<Registry>>,
    /// Per-model cache of the last GitHub release lookup. See
    /// [`CachedRelease`].
    releases: Arc<Mutex<HashMap<String, CachedRelease>>>,
}

impl ModelService {
    pub fn new(paths: Arc<AppPaths>) -> Self {
        Self {
            models_dir: paths.models.clone(),
            state: Arc::new(Mutex::new(Registry::default())),
            releases: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Absolute path a model's detector installs to.
    pub fn model_path(&self, id: &str) -> PathBuf {
        self.models_dir.join(models::file_name(id))
    }

    /// Absolute path a model's typer installs to (whether or not the
    /// model has one — callers gate on `spec.typer`).
    pub fn typer_path(&self, id: &str) -> PathBuf {
        self.models_dir.join(models::typer_file_name(id))
    }

    /// True when the model's artifact is fully on disk.
    pub fn is_installed(&self, spec: &ModelSpec) -> bool {
        is_installed_at(&self.models_dir, spec)
    }

    /// Snapshot every registry model with its live status.
    pub fn list(&self) -> Vec<ModelInfo> {
        let guard = self.state.lock().ok();
        models::REGISTRY
            .iter()
            .map(|spec| model_info(&self.models_dir, guard.as_deref(), spec))
            .collect()
    }

    /// Start downloading `id` on a worker thread. Doubles as the update
    /// path: an *outdated* model isn't installed-at-current-size, so this
    /// proceeds and `fetch_to_disk` skips the artifacts already at their
    /// current size while re-fetching (and overwriting) the changed ones.
    /// Idempotent: an in-flight download or an already-current install is
    /// an Ok no-op, so double-clicks and auto-download races are harmless.
    pub fn download(&self, app: &AppHandle, id: &str) -> AppResult<()> {
        let spec =
            models::find(id).ok_or_else(|| AppError::Models(format!("unknown model id: {id}")))?;
        if self.is_installed(spec) {
            return Ok(());
        }
        // Pinned, reproducible install: the compile-time registry artifacts.
        // The version label is the GitHub release tag the URL points at when
        // it's a GitHub model, else the registry version.
        let label = github_tag_from_url(spec.url).unwrap_or_else(|| format!("v{}", spec.version));
        self.spawn_download(app, spec, spec.artifacts(), label)
    }

    /// Self-update `id` to the latest published GitHub release — the live
    /// counterpart to [`download`](Self::download). Queries the release
    /// fresh (the registry's compile-time `size_bytes`/`url` are pinned to
    /// an older tag and can't fetch new bytes), resolves its detector +
    /// typer assets, and streams *those* into place, verifying each against
    /// the size GitHub reports. Reuses the same worker + events as a normal
    /// download, so the Models page shows the same progress bar and lands
    /// on `installed`. Errors when the model has no GitHub release source or
    /// the release's assets don't cover it.
    pub fn update_latest(&self, app: &AppHandle, id: &str) -> AppResult<()> {
        let spec =
            models::find(id).ok_or_else(|| AppError::Models(format!("unknown model id: {id}")))?;
        let src = spec
            .release
            .ok_or_else(|| AppError::Models(format!("{id} has no live release to update from")))?;
        // Fetch fresh — never self-update from a possibly-stale cache.
        let cached = fetch_release_state(id, &src)?;
        self.cache_release(id, cached.clone());
        if !cached.updatable {
            return Err(AppError::Models(format!(
                "latest {} release ({}) is missing the expected model assets",
                src.repo, cached.tag
            )));
        }
        self.spawn_download(app, spec, cached.artifacts, cached.tag)
    }

    /// Register an in-flight download for `spec` covering `artifacts`
    /// (pinned-registry or live-release), then stream them on a worker
    /// thread. Idempotent: an already-running download for this id is an Ok
    /// no-op. Shared by [`download`](Self::download) and
    /// [`update_latest`](Self::update_latest).
    fn spawn_download(
        &self,
        app: &AppHandle,
        spec: &'static ModelSpec,
        artifacts: Vec<ModelArtifact>,
        label: String,
    ) -> AppResult<()> {
        let total: u64 = artifacts.iter().map(|a| a.size_bytes).sum();
        let (downloaded, cancel) = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| AppError::Models("model state lock poisoned".into()))?;
            if guard.downloads.contains_key(spec.id) {
                return Ok(());
            }
            guard.errors.remove(spec.id);
            let downloaded = Arc::new(AtomicU64::new(0));
            let cancel = Arc::new(AtomicBool::new(false));
            guard.downloads.insert(
                spec.id.to_string(),
                DownloadHandle {
                    downloaded: downloaded.clone(),
                    total,
                    cancel: cancel.clone(),
                },
            );
            (downloaded, cancel)
        };

        // Status flipped to `downloading` — broadcast before the worker
        // starts so the UI reacts to the click immediately.
        emit_changed(app, &self.models_dir, &self.state);

        let app = app.clone();
        let models_dir = self.models_dir.clone();
        let state = Arc::clone(&self.state);
        let id = spec.id;
        std::thread::spawn(move || {
            let result = fetch_to_disk(
                &app,
                &models_dir,
                id,
                &artifacts,
                total,
                &label,
                &downloaded,
                &cancel,
            );
            {
                let mut guard = match state.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                guard.downloads.remove(id);
                match &result {
                    Ok(true) => {
                        tracing::info!(model = id, version = %label, "model installed");
                    }
                    Ok(false) => {
                        tracing::info!(model = id, "model download cancelled");
                    }
                    Err(e) => {
                        tracing::warn!(model = id, error = %e, "model download failed");
                        guard.errors.insert(id.to_string(), e.to_string());
                    }
                }
            }
            emit_changed(&app, &models_dir, &state);
        });
        Ok(())
    }

    /// Best-effort live release status for every GitHub-hosted model — what
    /// the Models page fires on open to answer "is my model the latest
    /// published one". A per-model failure (offline, rate-limited, asset
    /// mismatch) drops that model from the result rather than failing the
    /// whole call. The network half is cached ([`RELEASE_CACHE_TTL`]); the
    /// installed/up-to-date flags are always recomputed against disk.
    pub fn check_updates(&self) -> Vec<ReleaseCheck> {
        let mut out = Vec::new();
        for spec in models::REGISTRY {
            let Some(src) = spec.release else { continue };
            match self.cached_or_fetch(spec.id, &src) {
                Ok(cached) => out.push(build_check(&self.models_dir, spec, &cached)),
                Err(e) => {
                    tracing::warn!(model = spec.id, error = %e, "model release check failed")
                }
            }
        }
        out
    }

    /// Return the cached release for `id` when still fresh, else fetch +
    /// cache it.
    fn cached_or_fetch(&self, id: &str, src: &ReleaseSource) -> AppResult<CachedRelease> {
        if let Ok(cache) = self.releases.lock() {
            if let Some(c) = cache.get(id) {
                if c.fetched.elapsed() < RELEASE_CACHE_TTL {
                    return Ok(c.clone());
                }
            }
        }
        let fresh = fetch_release_state(id, src)?;
        self.cache_release(id, fresh.clone());
        Ok(fresh)
    }

    fn cache_release(&self, id: &str, release: CachedRelease) {
        if let Ok(mut cache) = self.releases.lock() {
            cache.insert(id.to_string(), release);
        }
    }

    /// Flag an in-flight download for cancellation. The worker notices
    /// at its next chunk, cleans up the `.part`, and emits `changed`.
    /// No-op when nothing is downloading.
    pub fn cancel(&self, id: &str) -> AppResult<()> {
        let guard = self
            .state
            .lock()
            .map_err(|_| AppError::Models("model state lock poisoned".into()))?;
        if let Some(handle) = guard.downloads.get(id) {
            handle.cancel.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    /// Remove an installed model from disk (cancelling a download in
    /// flight first). Emits `changed`. Idempotent.
    pub fn remove(&self, app: &AppHandle, id: &str) -> AppResult<()> {
        let spec =
            models::find(id).ok_or_else(|| AppError::Models(format!("unknown model id: {id}")))?;
        self.cancel(id)?;
        for art in spec.artifacts() {
            let path = self.models_dir.join(&art.file_name);
            if path.exists() {
                fs::remove_file(&path)
                    .map_err(|e| AppError::Models(format!("remove {}: {e}", art.file_name)))?;
            }
        }
        // Drop the install record alongside the bytes it described.
        let _ = fs::remove_file(manifest_path(&self.models_dir, id));
        if let Ok(mut guard) = self.state.lock() {
            guard.errors.remove(id);
        }
        // A removed model is no longer "up to date" against any cached
        // release; forget the lookup so the next check re-evaluates clean.
        if let Ok(mut cache) = self.releases.lock() {
            cache.remove(id);
        }
        emit_changed(app, &self.models_dir, &self.state);
        Ok(())
    }

    /// Readiness policy for the Object capture mode: resolve the
    /// configured detector (falling back to the registry default for a
    /// stale id), then `ready` if installed, `downloading` if a fetch is
    /// (or just got) started, `missing` when auto-download is off.
    pub fn ensure_object_model(
        &self,
        app: &AppHandle,
        prefs: &ModelsSettings,
    ) -> AppResult<ObjectModelReadiness> {
        let spec = resolve_object_spec(prefs);
        let status = if self.is_installed(spec) {
            ReadinessStatus::Ready
        } else if prefs.auto_download {
            self.download(app, spec.id)?;
            ReadinessStatus::Downloading
        } else {
            let downloading = self
                .state
                .lock()
                .map(|g| g.downloads.contains_key(spec.id))
                .unwrap_or(false);
            if downloading {
                ReadinessStatus::Downloading
            } else {
                ReadinessStatus::Missing
            }
        };
        let guard = self.state.lock().ok();
        Ok(ObjectModelReadiness {
            status,
            model: model_info(&self.models_dir, guard.as_deref(), spec),
        })
    }
}

/// Resolve the configured object-model id against the registry,
/// falling back to the default when the persisted id is unknown.
pub fn resolve_object_spec(prefs: &ModelsSettings) -> &'static ModelSpec {
    models::find(&prefs.object_model)
        .or_else(|| models::find(models::DEFAULT_OBJECT_MODEL))
        .expect("registry default model must exist")
}

// ------------------------------------------------------------- internals

/// True when every artifact is on disk at an *accepted* size: the
/// compile-time registry size, or — for a self-updated model — the size
/// recorded in its install manifest. Without the manifest fallback a model
/// fetched from a newer GitHub release (whose sizes the registry doesn't
/// know) would read as not-installed. Reads the manifest once and applies
/// it to every artifact.
fn is_installed_at(models_dir: &Path, spec: &ModelSpec) -> bool {
    let manifest = read_manifest(models_dir, spec.id);
    spec.artifacts().iter().all(|a| {
        let Some(len) = file_len(&models_dir.join(&a.file_name)) else {
            return false;
        };
        len == a.size_bytes
            || manifest
                .as_ref()
                .and_then(|m| m.sizes.get(&a.file_name))
                .is_some_and(|&recorded| recorded == len)
    })
}

/// `Some(len)` when `path` is a regular file; `None` otherwise.
fn file_len(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .filter(|m| m.is_file())
        .map(|m| m.len())
}

/// True when `path` is a file of exactly `size_bytes` — the per-artifact
/// integrity predicate (a partial or substituted file fails it).
fn artifact_on_disk(path: &Path, size_bytes: u64) -> bool {
    file_len(path) == Some(size_bytes)
}

/// True when a complete but *outdated* copy is on disk: every artifact is
/// present at a size the registry recognizes (the current size or one of
/// its `prior_sizes`), and at least one is at a prior size. This is what
/// distinguishes "an update is available" from "never installed" and from
/// "a corrupt/partial file" — only known older bytes count, so a random
/// wrong-sized file still reads as not-installed and gets re-fetched
/// cleanly. Mutually exclusive with [`is_installed_at`] (which requires
/// every artifact at its *current* size).
fn is_outdated_at(models_dir: &Path, spec: &ModelSpec) -> bool {
    let mut any_prior = false;
    for art in spec.artifacts() {
        let len = match fs::metadata(models_dir.join(&art.file_name)) {
            Ok(m) if m.is_file() => m.len(),
            // A missing artifact means this isn't a complete install at
            // all — defer to the not-installed path.
            _ => return false,
        };
        if len == art.size_bytes {
            continue; // this artifact is already current
        } else if art.prior_sizes.contains(&len) {
            any_prior = true; // a recognized previous release
        } else {
            return false; // unknown size → treat as not installed
        }
    }
    any_prior
}

/// Status precedence: an active download wins, then a complete current
/// install, then a recorded error (so a failed update surfaces its
/// reason), then an outdated install (update available), else
/// not-installed.
fn phase_of(models_dir: &Path, registry: Option<&Registry>, spec: &ModelSpec) -> ModelPhase {
    if let Some(reg) = registry {
        if let Some(h) = reg.downloads.get(spec.id) {
            return ModelPhase::Downloading {
                downloaded: h.downloaded.load(Ordering::Relaxed),
                total: h.total,
            };
        }
        if is_installed_at(models_dir, spec) {
            return ModelPhase::Installed;
        }
        if let Some(message) = reg.errors.get(spec.id) {
            return ModelPhase::Error {
                message: message.clone(),
            };
        }
        if is_outdated_at(models_dir, spec) {
            return ModelPhase::UpdateAvailable {
                version: spec.version.to_string(),
            };
        }
    } else if is_installed_at(models_dir, spec) {
        return ModelPhase::Installed;
    } else if is_outdated_at(models_dir, spec) {
        return ModelPhase::UpdateAvailable {
            version: spec.version.to_string(),
        };
    }
    ModelPhase::NotInstalled
}

/// Build the wire row for one model: its phase plus the precise on-disk
/// version. The single place `ModelInfo` is assembled from disk state, so
/// `list`, `emit_changed`, and `ensure_object_model` can't drift.
fn model_info(models_dir: &Path, registry: Option<&Registry>, spec: &ModelSpec) -> ModelInfo {
    let phase = phase_of(models_dir, registry, spec);
    let installed = installed_version_of(models_dir, spec);
    ModelInfo::from_spec(spec, phase).with_installed_version(installed)
}

/// Which version is actually on disk: the manifest's release tag when one
/// was recorded (a self-updated model), else the registry `version` when
/// the bytes match a pinned build, else `None` (nothing installed). This
/// is what turns "is something installed" into "which one".
fn installed_version_of(models_dir: &Path, spec: &ModelSpec) -> Option<String> {
    if !is_installed_at(models_dir, spec) {
        return None;
    }
    // Prefer a real tag (manifest, or the registry URL's tag for a pinned
    // build); fall back to the bare registry version only when neither
    // applies (e.g. a HuggingFace model with no release tag).
    installed_tag_of(models_dir, spec).or_else(|| Some(spec.version.to_string()))
}

/// Broadcast the full model list. Best-effort — a failed emit only
/// delays the UI until its next refetch.
fn emit_changed(app: &AppHandle, models_dir: &Path, state: &Arc<Mutex<Registry>>) {
    let guard = state.lock().ok();
    let list: Vec<ModelInfo> = models::REGISTRY
        .iter()
        .map(|spec| model_info(models_dir, guard.as_deref(), spec))
        .collect();
    drop(guard);
    let _ = events::emit(app, events::names::MODELS_CHANGED, list);
}

/// Stream every `artifact` (detector, then typer when present) into
/// `models_dir`, each via a `.part` renamed into place only after its
/// exact-size check. `artifacts` is the pinned registry list for a normal
/// download or the live-release list for a self-update — the streaming is
/// identical either way. Progress is cumulative across artifacts so the
/// settings bar fills once for the whole model. On success, records the
/// install manifest (`<id>.model.json`) stamping the fetched sizes +
/// `label` (the release tag / version). Returns `Ok(true)` on install,
/// `Ok(false)` on user cancel, `Err` on any network/fs/integrity failure.
/// An artifact already on disk at the right size is skipped, so a retry
/// after a mid-model failure resumes instead of re-fetching.
#[allow(clippy::too_many_arguments)]
fn fetch_to_disk(
    app: &AppHandle,
    models_dir: &Path,
    id: &str,
    artifacts: &[ModelArtifact],
    total: u64,
    label: &str,
    downloaded: &AtomicU64,
    cancel: &AtomicBool,
) -> AppResult<bool> {
    let mut cumulative: u64 = 0;
    let mut last_emit: u64 = 0;

    for art in artifacts {
        let final_path = models_dir.join(&art.file_name);
        // Already fully present (e.g. detector survived a typer-leg
        // failure) — count it and move on.
        if artifact_on_disk(&final_path, art.size_bytes) {
            cumulative += art.size_bytes;
            downloaded.store(cumulative, Ordering::Relaxed);
            continue;
        }

        let written = fetch_one(
            app,
            id,
            art,
            &final_path,
            models_dir,
            downloaded,
            cancel,
            &mut last_emit,
            cumulative,
            total,
        )?;
        // A user cancel surfaces as a short read turned size-mismatch;
        // distinguish it explicitly so the worker reports "cancelled".
        let Some(written) = written else {
            return Ok(false);
        };
        cumulative += written;
    }

    // Record what we installed so a self-update's (registry-unknown) sizes
    // still count as installed, and "which version" stays exact. Best-effort
    // — a missing manifest just falls back to registry-size detection.
    write_manifest(models_dir, id, label, artifacts);

    // Final 100% tick so the bar lands exactly on full.
    let _ = events::emit(
        app,
        events::names::MODELS_PROGRESS,
        ModelProgress {
            id: id.to_string(),
            downloaded: total,
            total,
        },
    );
    Ok(true)
}

/// Stream one artifact to `<file>.part`, integrity-check, rename into
/// place. `base`/`total` anchor this artifact's bytes inside the model's
/// cumulative progress. Returns `Ok(Some(written))` on success,
/// `Ok(None)` on user cancel, `Err` on network/fs/integrity failure.
#[allow(clippy::too_many_arguments)]
fn fetch_one(
    app: &AppHandle,
    id: &str,
    art: &ModelArtifact,
    final_path: &Path,
    models_dir: &Path,
    downloaded: &AtomicU64,
    cancel: &AtomicBool,
    last_emit: &mut u64,
    base: u64,
    total: u64,
) -> AppResult<Option<u64>> {
    let part_path = models_dir.join(format!("{}.part", art.file_name));

    // A best-effort guard that removes the .part on every exit path.
    struct PartGuard<'a> {
        path: &'a Path,
        keep: bool,
    }
    impl Drop for PartGuard<'_> {
        fn drop(&mut self) {
            if !self.keep {
                let _ = fs::remove_file(self.path);
            }
        }
    }
    let mut guard = PartGuard {
        path: &part_path,
        keep: false,
    };

    let mut response = ureq::get(&art.url)
        .call()
        .map_err(|e| AppError::Models(format!("download {}: {e}", art.file_name)))?;
    let mut reader = response.body_mut().as_reader();

    let mut file = fs::File::create(&part_path)
        .map_err(|e| AppError::Models(format!("create {}: {e}", part_path.display())))?;

    let mut buf = vec![0u8; CHUNK];
    let mut written: u64 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None); // guard removes the .part
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| AppError::Models(format!("download {}: read: {e}", art.file_name)))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| AppError::Models(format!("write {}: {e}", part_path.display())))?;
        written += n as u64;
        let done = base + written;
        downloaded.store(done, Ordering::Relaxed);
        if done - *last_emit >= PROGRESS_STRIDE {
            *last_emit = done;
            let _ = events::emit(
                app,
                events::names::MODELS_PROGRESS,
                ModelProgress {
                    id: id.to_string(),
                    downloaded: done,
                    total,
                },
            );
        }
    }
    file.flush()
        .map_err(|e| AppError::Models(format!("flush {}: {e}", part_path.display())))?;
    drop(file);

    // Integrity: the registry pins each artifact's exact size; anything
    // else is a truncated or substituted download.
    if written != art.size_bytes {
        return Err(AppError::Models(format!(
            "download {}: size mismatch (got {written} bytes, expected {})",
            art.file_name, art.size_bytes
        )));
    }

    fs::rename(&part_path, final_path)
        .map_err(|e| AppError::Models(format!("install {}: {e}", art.file_name)))?;
    guard.keep = true;
    Ok(Some(written))
}

// ----------------------------------------------------- install manifest

/// Path of a model's install record (`<id>.model.json`). Distinct from any
/// `.onnx` artifact, so it's never mistaken for one.
fn manifest_path(models_dir: &Path, id: &str) -> PathBuf {
    models_dir.join(format!("{id}.model.json"))
}

/// Read the install manifest, or `None` if absent/unreadable/corrupt.
/// Tolerant by design — a missing or garbled manifest just falls back to
/// registry-size detection, never an error.
fn read_manifest(models_dir: &Path, id: &str) -> Option<InstalledManifest> {
    let text = fs::read_to_string(manifest_path(models_dir, id)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Write the install manifest stamping `label` (release tag / version) and
/// the exact size of each installed artifact. Best-effort: a write failure
/// is logged, not propagated — the bytes are already in place, and the
/// worst case is a self-updated model later reading as not-installed.
fn write_manifest(models_dir: &Path, id: &str, label: &str, artifacts: &[ModelArtifact]) {
    let manifest = InstalledManifest {
        tag: label.to_string(),
        sizes: artifacts
            .iter()
            .map(|a| (a.file_name.clone(), a.size_bytes))
            .collect(),
    };
    match serde_json::to_string(&manifest) {
        Ok(json) => {
            if let Err(e) = fs::write(manifest_path(models_dir, id), json) {
                tracing::warn!(model = id, error = %e, "model manifest write failed");
            }
        }
        Err(e) => tracing::warn!(model = id, error = %e, "model manifest encode failed"),
    }
}

// -------------------------------------------------- live GitHub releases

/// Extract the release tag from a GitHub `releases/download/<tag>/<asset>`
/// URL, e.g. `onnx-v2`. `None` for any other URL shape (HuggingFace,
/// arbitrary hosts), which have no release tag to stamp.
fn github_tag_from_url(url: &str) -> Option<String> {
    let rest = url.split("/releases/download/").nth(1)?;
    let tag = rest.split('/').next()?;
    (!tag.is_empty()).then(|| tag.to_string())
}

/// Query a repo's latest published release and resolve its assets onto the
/// model's canonical on-disk artifact files. Network + parse + matching;
/// no disk reads (the installed/up-to-date flags are layered on later by
/// [`build_check`]).
fn fetch_release_state(id: &str, src: &ReleaseSource) -> AppResult<CachedRelease> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", src.repo);
    let body = ureq::get(&url)
        .header("User-Agent", GH_USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| AppError::Models(format!("release check {}: {e}", src.repo)))?
        .body_mut()
        .read_to_string()
        .map_err(|e| AppError::Models(format!("release check {}: read: {e}", src.repo)))?;
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| AppError::Models(format!("release check {}: parse: {e}", src.repo)))?;

    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Models(format!("release check {}: no tag_name", src.repo)))?
        .to_string();
    let published_at = json
        .get("published_at")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let html_url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let assets = json
        .get("assets")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    // Map the release's assets onto this model's detector (+ typer) slots,
    // under their canonical on-disk names. A missing match leaves the model
    // non-updatable but still reportable.
    let mut artifacts = Vec::new();
    let detector =
        resolve_asset(&assets, src.detector_match).map(|(asset_url, size)| ModelArtifact {
            file_name: models::file_name(id),
            url: asset_url,
            size_bytes: size,
            prior_sizes: &[],
        });
    let typer = src.typer_match.map(|m| {
        resolve_asset(&assets, m).map(|(asset_url, size)| ModelArtifact {
            file_name: models::typer_file_name(id),
            url: asset_url,
            size_bytes: size,
            prior_sizes: &[],
        })
    });

    // Updatable only when every slot the model needs resolved cleanly.
    let detector_ok = detector.is_some();
    let typer_ok = match &typer {
        None => true,          // detection-only model: no typer needed
        Some(Some(_)) => true, // typed model with its typer resolved
        Some(None) => false,   // typed model, typer asset missing
    };
    if let Some(d) = detector {
        artifacts.push(d);
    }
    if let Some(Some(t)) = typer {
        artifacts.push(t);
    }

    Ok(CachedRelease {
        fetched: Instant::now(),
        tag,
        published_at,
        html_url,
        artifacts,
        updatable: detector_ok && typer_ok,
    })
}

/// Find the first `.onnx` asset whose name contains `needle`, returning its
/// download URL + byte size. Matches across release renames as long as the
/// distinguishing substring (`det`, `typer`) survives.
fn resolve_asset(assets: &serde_json::Value, needle: &str) -> Option<(String, u64)> {
    assets.as_array()?.iter().find_map(|a| {
        let name = a.get("name")?.as_str()?;
        if name.ends_with(".onnx") && name.contains(needle) {
            let url = a.get("browser_download_url")?.as_str()?.to_string();
            let size = a.get("size")?.as_u64()?;
            Some((url, size))
        } else {
            None
        }
    })
}

/// Layer the disk-derived flags onto a cached release to produce the wire
/// verdict. `installed` = every artifact file present; `installed_is_latest`
/// = the *tag* on disk equals the latest release's tag.
///
/// Tag, not byte size: GitHub releases can ship byte-identical assets under
/// a new tag (a re-tagged release with the same-sized files), so a size
/// comparison would call the older-tag install "already latest" when the
/// newer tag is out. The installed tag comes from the manifest; for a
/// pre-feature install with no manifest, it's inferred from the registry
/// URL's tag when the bytes match the pinned registry build.
fn build_check(models_dir: &Path, spec: &ModelSpec, cached: &CachedRelease) -> ReleaseCheck {
    let present = spec
        .artifacts()
        .iter()
        .all(|a| models_dir.join(&a.file_name).is_file());
    let installed_tag = installed_tag_of(models_dir, spec);
    let is_latest = present && installed_tag.as_deref() == Some(cached.tag.as_str());
    ReleaseCheck {
        id: spec.id.to_string(),
        latest_tag: cached.tag.clone(),
        published_at: cached.published_at.clone(),
        html_url: cached.html_url.clone(),
        installed: present,
        installed_is_latest: is_latest,
        updatable: cached.updatable,
    }
}

/// The release tag of the bytes on disk, for tag-vs-tag freshness checks.
/// Prefers the install manifest; falls back to the registry URL's tag when
/// a manifest-less install's bytes match the pinned registry sizes (so a
/// model installed before manifests existed still compares correctly).
/// `None` when nothing recognizable is installed.
fn installed_tag_of(models_dir: &Path, spec: &ModelSpec) -> Option<String> {
    if let Some(m) = read_manifest(models_dir, spec.id) {
        return Some(m.tag);
    }
    let matches_registry = spec
        .artifacts()
        .iter()
        .all(|a| file_len(&models_dir.join(&a.file_name)) == Some(a.size_bytes));
    if matches_registry {
        github_tag_from_url(spec.url)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clippity_domain::models::DEFAULT_OBJECT_MODEL;

    /// A synthetic typed + GitHub-release model for exercising the
    /// update-detection paths that need a typer and a release tag. Kept
    /// here so these tests don't depend on any particular registered
    /// model. Its detector URL pins tag `rel-v2`.
    fn typed_release_spec() -> ModelSpec {
        ModelSpec {
            id: "typed-fixture",
            label: "Typed Fixture",
            description: "test-only typed model",
            task: models::ModelTask::ObjectDetection,
            version: "2",
            url: "https://github.com/octocat/model/releases/download/rel-v2/typed-fixture-det.onnx",
            size_bytes: 38_671_856,
            detector_prior_sizes: &[],
            input_size: 1280,
            labels: &models::UI_ELEMENT_LABELS,
            typer: Some(models::TyperSpec {
                artifact: models::ArtifactSpec {
                    url: "https://github.com/octocat/model/releases/download/rel-v2/typed-fixture-typer.onnx",
                    size_bytes: 6_138_446,
                    prior_sizes: &[6_134_346],
                },
                input_size: 224,
                crop_pad: 0.15,
                labels: &["button", "link", "icon"],
            }),
            release: Some(ReleaseSource {
                repo: "octocat/model",
                detector_match: "det",
                typer_match: Some("typer"),
            }),
            hint: "test",
        }
    }

    fn temp_models_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "clippity-models-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn service_with_dir(dir: PathBuf) -> ModelService {
        ModelService {
            models_dir: dir,
            state: Arc::new(Mutex::new(Registry::default())),
            releases: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Create a file of exactly `size` bytes without allocating it — the
    /// integrity check only reads the length, so a sparse file is enough
    /// to stand in for a multi-megabyte artifact in tests.
    fn write_sized(path: &Path, size: u64) {
        let f = fs::File::create(path).unwrap();
        f.set_len(size).unwrap();
    }

    #[test]
    fn list_reports_not_installed_on_empty_dir() {
        let dir = temp_models_dir("empty");
        let svc = service_with_dir(dir.clone());
        let list = svc.list();
        assert_eq!(list.len(), models::REGISTRY.len());
        assert!(list.iter().all(|m| m.phase == ModelPhase::NotInstalled));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn exact_size_file_counts_as_installed_wrong_size_does_not() {
        let dir = temp_models_dir("size");
        let svc = service_with_dir(dir.clone());
        let spec = models::find(DEFAULT_OBJECT_MODEL).unwrap();

        // Wrong size → not installed.
        fs::write(svc.model_path(spec.id), b"stub").unwrap();
        assert!(!svc.is_installed(spec));

        // Exact size → installed.
        fs::write(svc.model_path(spec.id), vec![0u8; spec.size_bytes as usize]).unwrap();
        assert!(svc.is_installed(spec));
        let phase = phase_of(&svc.models_dir, svc.state.lock().ok().as_deref(), spec);
        assert_eq!(phase, ModelPhase::Installed);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn typed_model_needs_both_detector_and_typer() {
        let dir = temp_models_dir("typed");
        let svc = service_with_dir(dir.clone());
        let spec = &typed_release_spec();
        let typer = spec.typer.unwrap();

        // Detector only → not installed (typer still missing).
        write_sized(&svc.model_path(spec.id), spec.size_bytes);
        assert!(!svc.is_installed(spec));

        // Both artifacts at exact sizes → installed.
        write_sized(&svc.typer_path(spec.id), typer.artifact.size_bytes);
        assert!(svc.is_installed(spec));

        // A wrong-sized typer fails the integrity check → not installed.
        write_sized(&svc.typer_path(spec.id), typer.artifact.size_bytes - 1);
        assert!(!svc.is_installed(spec));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn outdated_artifact_reports_update_available() {
        let dir = temp_models_dir("outdated");
        let svc = service_with_dir(dir.clone());
        let spec = &typed_release_spec();
        let typer = spec.typer.unwrap();
        let prior = typer.artifact.prior_sizes[0];

        // Detector current + typer at a recognized prior size → outdated.
        write_sized(&svc.model_path(spec.id), spec.size_bytes);
        write_sized(&svc.typer_path(spec.id), prior);
        assert!(!svc.is_installed(spec));
        let phase = phase_of(&svc.models_dir, svc.state.lock().ok().as_deref(), spec);
        assert_eq!(
            phase,
            ModelPhase::UpdateAvailable {
                version: spec.version.to_string()
            }
        );

        // Bring the typer to its current size → fully installed.
        write_sized(&svc.typer_path(spec.id), typer.artifact.size_bytes);
        assert!(svc.is_installed(spec));
        let phase = phase_of(&svc.models_dir, svc.state.lock().ok().as_deref(), spec);
        assert_eq!(phase, ModelPhase::Installed);

        // An *unrecognized* wrong size is not an update — it reads as a
        // fresh download so a corrupt/partial file gets cleanly replaced.
        write_sized(&svc.typer_path(spec.id), typer.artifact.size_bytes + 1);
        let phase = phase_of(&svc.models_dir, svc.state.lock().ok().as_deref(), spec);
        assert_eq!(phase, ModelPhase::NotInstalled);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn phase_prefers_active_download_over_disk_state() {
        let dir = temp_models_dir("phase");
        let svc = service_with_dir(dir.clone());
        let spec = models::find(DEFAULT_OBJECT_MODEL).unwrap();
        {
            let mut g = svc.state.lock().unwrap();
            g.downloads.insert(
                spec.id.to_string(),
                DownloadHandle {
                    downloaded: Arc::new(AtomicU64::new(123)),
                    total: spec.size_bytes,
                    cancel: Arc::new(AtomicBool::new(false)),
                },
            );
        }
        let phase = phase_of(&svc.models_dir, svc.state.lock().ok().as_deref(), spec);
        assert_eq!(
            phase,
            ModelPhase::Downloading {
                downloaded: 123,
                total: spec.size_bytes
            }
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn error_phase_surfaces_last_failure() {
        let dir = temp_models_dir("err");
        let svc = service_with_dir(dir.clone());
        let spec = models::find(DEFAULT_OBJECT_MODEL).unwrap();
        svc.state
            .lock()
            .unwrap()
            .errors
            .insert(spec.id.to_string(), "boom".into());
        let phase = phase_of(&svc.models_dir, svc.state.lock().ok().as_deref(), spec);
        assert_eq!(
            phase,
            ModelPhase::Error {
                message: "boom".into()
            }
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_object_spec_falls_back_on_unknown_id() {
        let prefs = ModelsSettings {
            object_model: "deleted-model".into(),
            ..Default::default()
        };
        assert_eq!(resolve_object_spec(&prefs).id, DEFAULT_OBJECT_MODEL);

        let prefs = ModelsSettings {
            object_model: "yolov10s".into(),
            ..Default::default()
        };
        assert_eq!(resolve_object_spec(&prefs).id, "yolov10s");
    }

    #[test]
    fn cancel_without_download_is_noop() {
        let dir = temp_models_dir("cancel");
        let svc = service_with_dir(dir.clone());
        svc.cancel("yolov10n").unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn github_tag_parses_from_release_url_only() {
        assert_eq!(
            github_tag_from_url(
                "https://github.com/octocat/model/releases/download/rel-v2/typed-fixture-det.onnx"
            )
            .as_deref(),
            Some("rel-v2")
        );
        // HuggingFace `resolve/main` has no release tag.
        assert_eq!(
            github_tag_from_url(
                "https://huggingface.co/onnx-community/yolov10n/resolve/main/onnx/model.onnx"
            ),
            None
        );
    }

    #[test]
    fn resolve_asset_matches_by_substring_and_onnx_suffix() {
        let assets = serde_json::json!([
            { "name": "model-det-s-v2.onnx", "size": 100, "browser_download_url": "http://x/det" },
            { "name": "model-typer.onnx",    "size": 50,  "browser_download_url": "http://x/typer" },
            { "name": "notes.txt",          "size": 9,   "browser_download_url": "http://x/txt" },
        ]);
        assert_eq!(
            resolve_asset(&assets, "det"),
            Some(("http://x/det".into(), 100))
        );
        assert_eq!(
            resolve_asset(&assets, "typer"),
            Some(("http://x/typer".into(), 50))
        );
        // A substring that only appears on a non-.onnx asset doesn't match.
        assert_eq!(resolve_asset(&assets, "notes"), None);
    }

    #[test]
    fn manifest_makes_registry_unknown_sizes_count_as_installed() {
        let dir = temp_models_dir("manifest");
        let svc = service_with_dir(dir.clone());
        let spec = &typed_release_spec();
        let typer = spec.typer.unwrap();

        // Simulate a self-update: both files at sizes the registry has
        // never seen (a hypothetical rel-v3).
        let new_det = spec.size_bytes + 4242;
        let new_typer = typer.artifact.size_bytes + 99;
        write_sized(&svc.model_path(spec.id), new_det);
        write_sized(&svc.typer_path(spec.id), new_typer);

        // Without a manifest those sizes are unrecognized → not installed.
        assert!(!svc.is_installed(spec));
        assert_eq!(installed_version_of(&svc.models_dir, spec), None);

        // The manifest the worker would have written makes them count, and
        // surfaces the exact installed version.
        write_manifest(
            &svc.models_dir,
            spec.id,
            "rel-v3",
            &[
                ModelArtifact {
                    file_name: models::file_name(spec.id),
                    url: String::new(),
                    size_bytes: new_det,
                    prior_sizes: &[],
                },
                ModelArtifact {
                    file_name: models::typer_file_name(spec.id),
                    url: String::new(),
                    size_bytes: new_typer,
                    prior_sizes: &[],
                },
            ],
        );
        assert!(svc.is_installed(spec));
        let phase = phase_of(&svc.models_dir, svc.state.lock().ok().as_deref(), spec);
        assert_eq!(phase, ModelPhase::Installed);
        assert_eq!(
            installed_version_of(&svc.models_dir, spec).as_deref(),
            Some("rel-v3")
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn registry_installed_model_reports_its_registry_version() {
        let dir = temp_models_dir("regver");
        let svc = service_with_dir(dir.clone());
        let spec = models::find("yolov10n").unwrap();
        // No manifest, files at exact registry sizes → version falls back
        // to the registry version.
        write_sized(&svc.model_path(spec.id), spec.size_bytes);
        assert_eq!(
            installed_version_of(&svc.models_dir, spec).as_deref(),
            Some(spec.version)
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn build_check_compares_tags_not_sizes() {
        let dir = temp_models_dir("check");
        let svc = service_with_dir(dir.clone());
        let spec = &typed_release_spec();
        let det_name = models::file_name(spec.id);
        let typer_name = models::typer_file_name(spec.id);
        let typer = spec.typer.unwrap();

        // rel-v3 ships byte-identical assets to the installed rel-v2 — the
        // exact case that broke a size-based check.
        let cached = CachedRelease {
            fetched: Instant::now(),
            tag: "rel-v3".into(),
            published_at: "2026-06-21T00:00:00Z".into(),
            html_url: "http://example/release".into(),
            artifacts: vec![
                ModelArtifact {
                    file_name: det_name.clone(),
                    url: "u".into(),
                    size_bytes: spec.size_bytes,
                    prior_sizes: &[],
                },
                ModelArtifact {
                    file_name: typer_name.clone(),
                    url: "u".into(),
                    size_bytes: typer.artifact.size_bytes,
                    prior_sizes: &[],
                },
            ],
            updatable: true,
        };

        // Nothing on disk → not installed, not latest, but fetchable.
        let c = build_check(&svc.models_dir, spec, &cached);
        assert!(!c.installed && !c.installed_is_latest && c.updatable);
        assert_eq!(c.latest_tag, "rel-v3");

        // Installed at rel-v2 (manifest tag) with the SAME bytes v3 ships —
        // still "newer release available", because the tag differs.
        write_sized(&svc.model_path(spec.id), spec.size_bytes);
        write_sized(&svc.typer_path(spec.id), typer.artifact.size_bytes);
        write_manifest(
            &svc.models_dir,
            spec.id,
            "rel-v2",
            &[
                ModelArtifact {
                    file_name: det_name.clone(),
                    url: String::new(),
                    size_bytes: spec.size_bytes,
                    prior_sizes: &[],
                },
                ModelArtifact {
                    file_name: typer_name.clone(),
                    url: String::new(),
                    size_bytes: typer.artifact.size_bytes,
                    prior_sizes: &[],
                },
            ],
        );
        let c = build_check(&svc.models_dir, spec, &cached);
        assert!(
            c.installed && !c.installed_is_latest,
            "v2 tag must read as behind v3"
        );

        // Re-stamp to rel-v3 (as a self-update would) → now up to date.
        write_manifest(
            &svc.models_dir,
            spec.id,
            "rel-v3",
            &[
                ModelArtifact {
                    file_name: det_name.clone(),
                    url: String::new(),
                    size_bytes: spec.size_bytes,
                    prior_sizes: &[],
                },
                ModelArtifact {
                    file_name: typer_name.clone(),
                    url: String::new(),
                    size_bytes: typer.artifact.size_bytes,
                    prior_sizes: &[],
                },
            ],
        );
        let c = build_check(&svc.models_dir, spec, &cached);
        assert!(c.installed && c.installed_is_latest);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn manifestless_registry_install_infers_tag_from_url() {
        let dir = temp_models_dir("infertag");
        let svc = service_with_dir(dir.clone());
        let spec = &typed_release_spec();
        let typer = spec.typer.unwrap();
        // Pinned registry bytes, no manifest (pre-feature install).
        write_sized(&svc.model_path(spec.id), spec.size_bytes);
        write_sized(&svc.typer_path(spec.id), typer.artifact.size_bytes);
        // The registry URL pins rel-v2, so that's the inferred installed tag.
        assert_eq!(
            installed_tag_of(&svc.models_dir, spec).as_deref(),
            Some("rel-v2")
        );
        assert_eq!(
            installed_version_of(&svc.models_dir, spec).as_deref(),
            Some("rel-v2")
        );
        let _ = fs::remove_dir_all(dir);
    }
}
