//! Media orchestration — describe a saved clip so Studio can play it,
//! and hand its bytes to the webview.
//!
//! The counterpart to [`crate::editor_service`]: that one loads a
//! screenshot to be annotated, this one opens a recording to be reviewed
//! and cut. They differ in one structural way, and it is the reason this
//! is a separate service rather than two more methods on that one.
//!
//! **A screenshot is delivered; a recording is streamed.** `editor_load`
//! base64s an entire PNG into a command's return value, which is fine
//! for a few megabytes. A recording is routinely three orders of
//! magnitude larger, and a `<video>` element needs to *seek* into it —
//! it issues ranged requests and expects partial responses. So the bytes
//! never travel over IPC at all. Studio calls [`MediaService::probe`],
//! gets a [`MediaToken`], and the webview fetches ranges of the file
//! over the `clippity-media` URI scheme, which resolves that token back
//! to a path through [`MediaService::resolve`].
//!
//! Validation: every `id` goes through `library::validate_id` before it
//! becomes a token, so the scheme handler — which runs on webview input
//! and has no session context — never has to decide for itself whether
//! a path is allowed. A token *is* the proof that the check passed.
//!
//! Concurrency: the token registry is the only state, behind a `Mutex`.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use clippity_domain::annotation::OverlayRef;
use clippity_domain::library::{self, CaptureKind};
use clippity_domain::media::{
    self, MediaInfo, MediaToken, TrimProgress, TrimRequest, TrimResult, ValidatedTrim, ASSUMED_FPS,
};
use clippity_domain::metadata::CaptureSource;
use clippity_infra::error::{AppError, AppResult};
#[cfg(target_os = "windows")]
use clippity_platform::windows::media_foundation::{AUDIO_BLOCK_ALIGN, AUDIO_SAMPLE_RATE};

use crate::capture_io;
use crate::recorder_service::sink;
use crate::settings_service::{CapturesDirSource, NameTemplateSource};

/// How many clips stay fetchable at once.
///
/// Studio shows one clip at a time, so one would nearly do — but "nearly"
/// is where the bugs are. A webview keeps in-flight ranged requests
/// against the *previous* clip alive for a moment after the `<video>`
/// src changes, and a page reload re-probes while the old element is
/// still tearing down. A small ring absorbs both without ever letting
/// the registry grow with the session.
const MAX_LIVE_TOKENS: usize = 8;

/// Largest single staged overlay bitmap.
///
/// An overlay is mostly transparent and compresses hard, so a real one
/// is tens of kilobytes even at 5120×1440. This is a backstop on a
/// base64 string that arrives from the webview and is decoded into
/// memory before anything else looks at it.
const MAX_OVERLAY_BYTES: usize = 32 * 1024 * 1024;

/// Where rendered overlay bitmaps are staged.
///
/// A directory of our choosing, never the caller's — which is what makes
/// [`MediaService::stage_overlay`] safe to expose and what
/// [`validate_overlays`] checks trim requests against.
fn overlay_staging_dir() -> PathBuf {
    std::env::temp_dir().join("clippity-overlays")
}

/// Refuse overlay paths that did not come from the staging directory.
///
/// The paths in a trim request arrive from the webview, and the encoder
/// opens them. Without this, a page could name any file on disk and have
/// the export read it — the same class of hole `library::validate_id`
/// closes for capture ids, and the reason the playback scheme carries a
/// token instead of a path at all (ADR 0032).
///
/// Compares canonicalised paths, so `..` segments and symlinks are
/// resolved before the prefix test rather than after it.
fn validate_overlays(overlays: &[OverlayRef]) -> AppResult<()> {
    if overlays.is_empty() {
        return Ok(());
    }
    let root = overlay_staging_dir().canonicalize().map_err(|e| {
        AppError::Media(format!("the overlay staging directory is unavailable: {e}"))
    })?;

    for overlay in overlays {
        let path = std::path::Path::new(&overlay.path)
            .canonicalize()
            .map_err(|e| {
                AppError::Media(format!("overlay {} is not readable: {e}", overlay.path))
            })?;
        if !path.starts_with(&root) {
            return Err(AppError::Media(
                "an annotation overlay must be one this app staged".into(),
            ));
        }
    }
    Ok(())
}

pub struct MediaService {
    captures: Arc<dyn CapturesDirSource>,
    /// Names a trimmed clip the same way every other capture is named,
    /// so an export lands in the library looking like it belongs.
    naming: Arc<dyn NameTemplateSource>,
    /// Minted tokens, oldest first. Bounded by [`MAX_LIVE_TOKENS`].
    live: Mutex<VecDeque<(MediaToken, PathBuf)>>,
    /// Monotonic across the process. Never reset and never reused, so a
    /// URL left in the webview's cache from an earlier clip resolves to
    /// a 404 rather than to whichever file now occupies that slot.
    next_token: AtomicU64,
    /// Cancellation flag for the trim currently encoding, if any.
    ///
    /// Held here rather than passed around because the party that wants
    /// to cancel — a command handler serving a button press — is not the
    /// party running the encode, and the two never meet. An `Arc` so the
    /// worker keeps its own handle after this slot is cleared.
    active_trim: Mutex<Option<Arc<AtomicBool>>>,
}

impl MediaService {
    pub fn new(captures: Arc<dyn CapturesDirSource>, naming: Arc<dyn NameTemplateSource>) -> Self {
        Self {
            captures,
            naming,
            live: Mutex::new(VecDeque::new()),
            // Starts at 1 so a falsy 0 can never be mistaken for a valid
            // token by the frontend's `if (token)` checks.
            next_token: AtomicU64::new(1),
            active_trim: Mutex::new(None),
        }
    }

    /// Ask the running trim to stop. A no-op when none is running.
    ///
    /// Cooperative: the encode loop polls between frames, so the export
    /// unwinds at a frame boundary and deletes its working file rather
    /// than being killed with a half-written container on disk.
    pub fn cancel_trim(&self) {
        if let Ok(active) = self.active_trim.lock() {
            if let Some(flag) = active.as_ref() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    /// Describe the clip at `id` and mint the token its bytes are
    /// fetchable under.
    ///
    /// Rejects anything that isn't a video. Studio's timeline is built
    /// on seeking, and the two other things the library holds cannot be
    /// seeked: a still has no time axis, and an animated GIF has one the
    /// platform's decoder won't expose. Refusing here — rather than
    /// opening a player that turns out not to scrub — is why the library
    /// only offers Studio for `video` entries in the first place.
    pub fn probe(&self, id: &str) -> AppResult<MediaInfo> {
        let path = library::validate_id(id, &self.captures.captures_dir())?;

        let extension = path.extension().and_then(|e| e.to_str());
        if library::kind_of(extension) != CaptureKind::Video {
            return Err(AppError::Media(
                "only recordings can be opened in Studio".into(),
            ));
        }
        if !path.is_file() {
            return Err(AppError::Media(format!("{id} is no longer on disk")));
        }

        let probed = probe_file(&path)?;
        if probed.duration_ms == 0 {
            // A zero-length recording is a session that died before its
            // first fragment committed. There is nothing to scrub.
            return Err(AppError::Media(
                "this recording contains no playable video".into(),
            ));
        }

        let token = self.mint(path);
        Ok(MediaInfo {
            id: id.to_string(),
            token,
            width: probed.width,
            height: probed.height,
            duration_ms: probed.duration_ms,
            // The container is allowed to omit its rate; the domain's
            // assumption is applied here, at the one place a `MediaInfo`
            // is built, so no consumer downstream has to handle a zero.
            fps: probed.fps.unwrap_or(ASSUMED_FPS),
            has_audio: probed.has_audio,
        })
    }

    /// Cut `request` out of its source and encode it as a new capture.
    ///
    /// **A trim decodes and re-encodes rather than remuxing**, and that
    /// is the central decision here. Copying the compressed stream would
    /// be near-instant and lossless, but a cut can only land on a
    /// keyframe — so an in-point would silently jump to the nearest one
    /// before it, by up to a couple of seconds on a screen recording. A
    /// trim UI whose handles are decorative is worse than one that takes
    /// a moment, because the user cannot see that it lied.
    ///
    /// Re-encoding also buys trim-to-GIF for nothing: frames arrive as
    /// RGBA and [`RecordingSink`] already knows two ways to write those,
    /// so the format fork is one argument, exactly as it is for a live
    /// recording (ADR 0031).
    ///
    /// `progress` is called as the output grows; `cancel` is polled
    /// between frames. A cancelled or failed trim leaves nothing behind
    /// — the working file is dot-prefixed so the library scan skips it,
    /// and it is deleted on every exit path that doesn't commit.
    pub fn trim(
        &self,
        request: &TrimRequest,
        progress: &dyn Fn(TrimProgress),
    ) -> AppResult<TrimResult> {
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut active = self
                .active_trim
                .lock()
                .map_err(|_| AppError::Media("the export lock was poisoned".into()))?;
            if active.is_some() {
                return Err(AppError::Media("an export is already running".into()));
            }
            *active = Some(cancel.clone());
        }
        let outcome = self.encode(request, &cancel, progress);
        if let Ok(mut active) = self.active_trim.lock() {
            *active = None;
        }
        outcome
    }

    /// The trim itself, with the cancellation flag already registered.
    fn encode(
        &self,
        request: &TrimRequest,
        cancel: &AtomicBool,
        progress: &dyn Fn(TrimProgress),
    ) -> AppResult<TrimResult> {
        let source = self.probe(&request.id)?;
        let trim =
            media::validate_trim(request, &source).map_err(|e| AppError::Media(e.to_string()))?;
        let path = library::validate_id(&request.id, &self.captures.captures_dir())?;
        // Checked before anything is encoded, so a bad overlay path
        // fails the request rather than half an export.
        validate_overlays(&trim.overlays)?;

        let destination = self.captures.captures_dir();
        // Dot-prefixed and in the destination directory, for the two
        // reasons the recorder's working file is: the library scan skips
        // it while it is being written (or if we die mid-write), and the
        // commit is a same-volume rename rather than a copy.
        let working = destination.join(format!(
            ".clippity-trim-{}.{}",
            capture_io::next_id(),
            trim.format.extension()
        ));

        let outcome = encode_trim(&path, &working, &trim, cancel, progress);
        // The overlays existed only to be encoded, and they are large.
        // Cleared on every exit path — a cancelled or failed export must
        // not leave a pile of full-resolution bitmaps in the temp
        // directory.
        for overlay in &trim.overlays {
            let _ = std::fs::remove_file(&overlay.path);
        }
        if outcome.is_err() || cancel.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(&working);
        }
        outcome?;
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Media("the export was cancelled".into()));
        }

        let saved = capture_io::promote_capture_file(
            &working,
            &destination,
            &self.naming.name_template(),
            // Provenance says how this clip came to exist. "Trimmed"
            // rather than the source's own mode: the file is a new
            // capture, and claiming it was recorded would make the
            // library's history a fiction.
            &CaptureSource::from_mode("Trimmed"),
            trim.format.extension(),
        )
        .map_err(|e| AppError::Media(format!("could not save the trimmed clip: {e}")))?;

        let (width, height) = trim.output_size();
        Ok(TrimResult {
            path: saved.to_string_lossy().into_owned(),
            format: trim.format,
            duration_ms: trim.duration_ms(),
            width,
            height,
            has_audio: trim.with_audio,
        })
    }

    /// Write one rendered overlay bitmap to the staging directory and
    /// return its path.
    ///
    /// The webview renders annotations to a PNG with the same canvas
    /// code that draws them on screen, and this is how that PNG reaches
    /// the encoder. Staged to a file rather than carried inline in the
    /// trim request for the reason ADR 0032 gave for the clip itself: a
    /// handful of full-resolution bitmaps is megabytes, and IPC
    /// serialises a payload whole.
    ///
    /// Three things are checked, and each is load-bearing:
    ///
    /// - **The path is ours.** The caller names no path, only bytes, so
    ///   there is nothing here for a page to point somewhere else.
    /// - **The bytes are a PNG.** Checked by signature rather than
    ///   trusted, so this cannot be used to drop arbitrary content into
    ///   a predictable location.
    /// - **The size is capped.** A base64 string from the webview is
    ///   decoded into memory before it is anything else.
    pub fn stage_overlay(&self, png_base64: &str) -> AppResult<String> {
        use base64::Engine;

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(png_base64.trim())
            .map_err(|e| AppError::Media(format!("the overlay was not valid base64: {e}")))?;

        if bytes.len() > MAX_OVERLAY_BYTES {
            return Err(AppError::Media(format!(
                "an annotation overlay may not exceed {} MiB",
                MAX_OVERLAY_BYTES / (1024 * 1024)
            )));
        }
        // The 8-byte PNG signature. Checked rather than assumed: this
        // writes webview-supplied bytes to a file, and "it is a PNG
        // because the caller said so" is not a check.
        const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        if !bytes.starts_with(PNG_MAGIC) {
            return Err(AppError::Media("an overlay must be a PNG".into()));
        }

        let dir = overlay_staging_dir();
        std::fs::create_dir_all(&dir).map_err(|e| {
            AppError::Media(format!("could not create the overlay staging dir: {e}"))
        })?;
        let path = dir.join(format!("overlay-{}.png", capture_io::next_id()));
        std::fs::write(&path, &bytes)
            .map_err(|e| AppError::Media(format!("could not stage the overlay: {e}")))?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// The file a token stands for, or `None` if it was never minted or
    /// has aged out of the ring.
    ///
    /// The `clippity-media` scheme handler's whole authorization step:
    /// a token exists only because [`probe`](Self::probe) validated the
    /// id that produced it.
    pub fn resolve(&self, token: MediaToken) -> Option<PathBuf> {
        let live = self.live.lock().ok()?;
        live.iter()
            .find(|(t, _)| *t == token)
            .map(|(_, path)| path.clone())
    }

    /// Register a path under a fresh token, evicting the oldest once the
    /// ring is full.
    fn mint(&self, path: PathBuf) -> MediaToken {
        let token = MediaToken(self.next_token.fetch_add(1, Ordering::Relaxed));
        if let Ok(mut live) = self.live.lock() {
            live.push_back((token, path));
            while live.len() > MAX_LIVE_TOKENS {
                live.pop_front();
            }
        }
        token
    }
}

/// Overlay bitmaps, decoded on demand and one at a time.
///
/// Frames arrive in timestamp order, so at most one overlay is ever
/// needed and the next is only reached when the playhead crosses an
/// annotation boundary. Holding one decoded bitmap rather than all of
/// them is what keeps a clip with a dozen annotations from costing a
/// dozen full-resolution RGBA buffers — on this desk's 5120×1440 panel
/// that is 29 MiB each.
///
/// Keyed on the path rather than on an index, so an interval that
/// re-uses an overlay costs a string comparison instead of a PNG decode.
struct OverlayCache<'a> {
    refs: &'a [OverlayRef],
    loaded: Option<(String, image::RgbaImage)>,
    /// A size mismatch is reported once, not once per frame — at 60 fps
    /// the log would be the slowest part of the export.
    warned_about_size: bool,
}

impl<'a> OverlayCache<'a> {
    fn new(refs: &'a [OverlayRef]) -> Self {
        Self {
            refs,
            loaded: None,
            warned_about_size: false,
        }
    }

    /// The overlay covering `ms`, decoding it if it isn't the one in
    /// hand. `None` when no annotation is showing then.
    ///
    /// Takes the frame size so a mismatch can be noticed at the moment
    /// the overlay is decoded, which is the only place both numbers are
    /// known.
    fn for_ms(
        &mut self,
        ms: u64,
        frame_w: u32,
        frame_h: u32,
    ) -> AppResult<Option<&image::RgbaImage>> {
        // Copied out first so the lookup's borrow does not outlive into
        // the mutation below — `refs` is a shared slice, so this is a
        // pointer copy rather than a clone of anything.
        let refs = self.refs;
        let Some(overlay) = clippity_domain::annotation::overlay_at(refs, ms) else {
            return Ok(None);
        };

        if self.loaded.as_ref().map(|(path, _)| path.as_str()) != Some(overlay.path.as_str()) {
            let decoded = image::open(&overlay.path)
                .map_err(|e| {
                    AppError::Media(format!(
                        "could not read the annotation overlay {}: {e}",
                        overlay.path
                    ))
                })?
                .to_rgba8();
            // A mismatch is not an error: the composite covers the
            // overlapping region, and failing a whole export over an
            // off-by-one in a size the user never chose is the worse
            // trade. But it does mean the webview rendered at the wrong
            // resolution, which is a bug worth leaving a trace of.
            let (w, h) = decoded.dimensions();
            if (w != frame_w || h != frame_h) && !self.warned_about_size {
                self.warned_about_size = true;
                tracing::warn!(
                    "annotation overlay {} is {w}x{h} but frames are \
                     {frame_w}x{frame_h}; compositing the overlap only",
                    overlay.path
                );
            }
            self.loaded = Some((overlay.path.clone(), decoded));
        }
        Ok(self.loaded.as_ref().map(|(_, image)| image))
    }
}

/// Decode `[start, end)` out of `source` and encode it to `working`.
///
/// Split out of the service so the `cfg` and the COM apartment live in
/// one place. Runs entirely on the calling thread — Media Foundation's
/// reader and writer are both `!Send`, and this is a foreground job with
/// nothing to gain from crossing a thread.
#[cfg(target_os = "windows")]
fn encode_trim(
    source: &std::path::Path,
    working: &std::path::Path,
    trim: &ValidatedTrim,
    cancel: &AtomicBool,
    progress: &dyn Fn(TrimProgress),
) -> AppResult<()> {
    use clippity_domain::recorder::{frame_duration_hns, hns_from_millis, HNS_PER_SECOND};
    use clippity_platform::windows::media_foundation::ComThread;
    use clippity_platform::windows::media_reader::Decoder;
    use image::RgbaImage;

    let _com = ComThread::init()?;

    let mut decoder = Decoder::open(source, trim.with_audio)?;
    let mut sink = sink::open(working, trim.format, sink::SinkConfig::for_trim(trim))?;
    let mut overlays = OverlayCache::new(&trim.overlays);

    let start_hns = hns_from_millis(trim.start_ms);
    let end_hns = hns_from_millis(trim.end_ms);
    let total_ms = trim.duration_ms();
    // Output frame spacing. Used to *decimate*, not to re-time: a 60 fps
    // source going into a 15 fps GIF must drop three frames in four, or
    // the file would carry four times the frames each holding for a
    // fifteenth of a second — a clip four times too long.
    let frame_spacing_hns = frame_duration_hns(trim.fps);

    // Seeking lands on the keyframe at or before the in-point, so the
    // first frames decoded may predate it. They are decoded (the ones
    // after depend on them) and discarded here.
    decoder.seek(start_hns)?;

    let mut emitted_hns: Option<i64> = None;
    let mut last_reported_ms = u64::MAX;

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let Some(frame) = decoder.read_video()? else {
            break;
        };
        if frame.timestamp_hns >= end_hns {
            break;
        }
        if frame.timestamp_hns < start_hns {
            continue;
        }
        let position_hns = frame.timestamp_hns - start_hns;
        // Keep the first frame unconditionally: a trim whose opening
        // frame was decimated away would start on black.
        let due = emitted_hns
            .map(|last| position_hns - last >= frame_spacing_hns)
            .unwrap_or(true);
        if !due {
            continue;
        }

        let mut image = RgbaImage::from_raw(decoder.width(), decoder.height(), frame.rgba)
            .ok_or_else(|| AppError::Media("a decoded frame had the wrong size".into()))?;

        // Burn in the annotations. Keyed on the frame's **source**
        // timestamp, not on `position_hns`: the user placed these on the
        // source's timeline in Studio, so a trim starting at 0:30 has to
        // look them up where they were put. Using the output position
        // would shift every annotation by the in-point.
        if trim.has_annotations() {
            let source_ms = (frame.timestamp_hns / (HNS_PER_SECOND / 1_000)).max(0) as u64;
            clippity_domain::annotation::apply_redactions(&mut image, &trim.redactions, source_ms);
            let (fw, fh) = image.dimensions();
            if let Some(overlay) = overlays.for_ms(source_ms, fw, fh)? {
                clippity_domain::annotation::composite_over(&mut image, overlay);
            }
        }

        sink.write_frame(
            sink::SinkFrame::rgba(&image),
            position_hns,
            frame_spacing_hns,
        )?;
        emitted_hns = Some(position_hns);

        let encoded_ms = (position_hns / (HNS_PER_SECOND / 1_000)) as u64;
        // Report at most once per output millisecond-decisecond; the
        // event crosses an IPC boundary and a per-frame emit would cost
        // more than the encode.
        if encoded_ms / 100 != last_reported_ms / 100 {
            last_reported_ms = encoded_ms;
            progress(TrimProgress {
                encoded_ms,
                total_ms,
            });
        }
    }

    if trim.with_audio && sink.wants_audio() {
        while let Some(chunk) = decoder.read_audio()? {
            if cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            if chunk.timestamp_hns >= end_hns {
                break;
            }
            if chunk.timestamp_hns < start_hns || chunk.pcm.is_empty() {
                continue;
            }
            // Duration from the sample count, never from the clock —
            // the sample rate *is* the audio timeline, and deriving it
            // from anything else is how tracks drift (ADR 0031).
            let frames = chunk.pcm.len() as i64 / AUDIO_BLOCK_ALIGN as i64;
            let duration_hns = frames * HNS_PER_SECOND / AUDIO_SAMPLE_RATE as i64;
            sink.write_audio(&chunk.pcm, chunk.timestamp_hns - start_hns, duration_hns)?;
        }
    }

    if emitted_hns.is_none() {
        return Err(AppError::Media(
            "no frames were found in the selected range".into(),
        ));
    }

    progress(TrimProgress {
        encoded_ms: total_ms,
        total_ms,
    });
    sink.finish()
}

#[cfg(not(target_os = "windows"))]
fn encode_trim(
    _source: &std::path::Path,
    _working: &std::path::Path,
    _trim: &ValidatedTrim,
    _cancel: &AtomicBool,
    _progress: &dyn Fn(TrimProgress),
) -> AppResult<()> {
    Err(AppError::Unsupported(
        "trimming a recording requires Windows Media Foundation",
    ))
}

/// Platform probe, behind the one `cfg` this service needs.
#[cfg(target_os = "windows")]
fn probe_file(path: &std::path::Path) -> AppResult<ProbeOutcome> {
    let probed = clippity_platform::windows::media_reader::probe(path)?;
    Ok(ProbeOutcome {
        width: probed.width,
        height: probed.height,
        duration_ms: probed.duration_ms,
        fps: probed.fps(),
        has_audio: probed.has_audio,
    })
}

#[cfg(not(target_os = "windows"))]
fn probe_file(_path: &std::path::Path) -> AppResult<ProbeOutcome> {
    Err(AppError::Unsupported(
        "reading a recording requires Windows Media Foundation",
    ))
}

/// The platform-independent shape of a probe, so the service body has
/// no `cfg` in it.
struct ProbeOutcome {
    width: u32,
    height: u32,
    duration_ms: u64,
    fps: Option<u32>,
    has_audio: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings_service::{StaticCapturesDir, StaticNameTemplate};
    use std::fs;
    use std::sync::atomic::AtomicU64 as TestNonce;

    /// Hermetic harness — same shape as `editor_service`'s.
    struct TestHarness {
        root: PathBuf,
        captures: PathBuf,
        service: MediaService,
    }

    impl Drop for TestHarness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    static TEST_NONCE: TestNonce = TestNonce::new(0);

    fn harness() -> TestHarness {
        let n = TEST_NONCE.fetch_add(1, Ordering::Relaxed);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("clippity-media-test-{ts}-{n}"));
        let captures = root.join("captures");
        fs::create_dir_all(&captures).unwrap();
        let captures_src: Arc<dyn CapturesDirSource> =
            Arc::new(StaticCapturesDir(captures.clone()));
        let naming: Arc<dyn NameTemplateSource> = Arc::new(StaticNameTemplate(String::new()));
        TestHarness {
            service: MediaService::new(captures_src, naming),
            captures,
            root,
        }
    }

    #[test]
    fn probe_rejects_a_path_outside_the_captures_root() {
        let h = harness();
        let err = h.service.probe("/etc/passwd").unwrap_err();
        assert_eq!(err.code(), "library");
    }

    #[test]
    fn probe_rejects_a_still_image() {
        // Studio's timeline is seeking; a screenshot has no time axis.
        let h = harness();
        let path = h.captures.join("Shot.png");
        fs::write(&path, b"not really a png").unwrap();
        let err = h.service.probe(&path.to_string_lossy()).unwrap_err();
        assert_eq!(err.code(), "media");
        assert!(err.to_string().contains("Studio"), "got {err}");
    }

    #[test]
    fn probe_rejects_a_gif() {
        // A GIF decodes as an image everywhere else in the app, which is
        // exactly why it must not reach the player: the platform decoder
        // will not seek one.
        let h = harness();
        let path = h.captures.join("Loop.gif");
        fs::write(&path, b"GIF89a").unwrap();
        let err = h.service.probe(&path.to_string_lossy()).unwrap_err();
        assert_eq!(err.code(), "media");
    }

    #[test]
    fn probe_reports_a_missing_file_rather_than_failing_in_the_decoder() {
        let h = harness();
        let path = h.captures.join("Gone.mp4");
        let err = h.service.probe(&path.to_string_lossy()).unwrap_err();
        assert_eq!(err.code(), "media");
        assert!(err.to_string().contains("no longer on disk"), "got {err}");
    }

    // ---------- the token registry ----------

    #[test]
    fn an_unminted_token_resolves_to_nothing() {
        let h = harness();
        assert!(h.service.resolve(MediaToken(1)).is_none());
    }

    #[test]
    fn a_minted_token_resolves_to_its_path() {
        let h = harness();
        let path = h.captures.join("Rec.mp4");
        let token = h.service.mint(path.clone());
        assert_eq!(h.service.resolve(token), Some(path));
    }

    #[test]
    fn tokens_are_never_reused_so_a_stale_url_cannot_hit_a_new_clip() {
        let h = harness();
        let first = h.service.mint(h.captures.join("A.mp4"));
        let second = h.service.mint(h.captures.join("B.mp4"));
        assert_ne!(first, second);
        assert_eq!(h.service.resolve(first), Some(h.captures.join("A.mp4")));
    }

    #[test]
    fn a_token_is_never_zero() {
        // The frontend truthiness-checks it.
        let h = harness();
        assert_ne!(h.service.mint(h.captures.join("A.mp4")), MediaToken(0));
    }

    // ---------- live-hardware tests ----------
    //
    // ---------- overlay staging ----------

    #[test]
    fn a_staged_overlay_lands_in_our_directory_and_is_accepted() {
        let h = harness();
        let path = h
            .service
            .stage_overlay(&overlay_png_base64(8, 8))
            .expect("stages");
        assert!(std::path::Path::new(&path).is_file());
        assert!(validate_overlays(&[OverlayRef {
            path,
            start_ms: 0,
            end_ms: 1,
        }])
        .is_ok());
    }

    #[test]
    fn staging_refuses_bytes_that_are_not_a_png() {
        use base64::Engine;

        // The check that stops this being a way to drop arbitrary
        // content into a predictable location.
        let h = harness();
        let payload = base64::engine::general_purpose::STANDARD.encode(b"MZ\x90\x00 not a png");
        assert!(h.service.stage_overlay(&payload).is_err());
        assert!(h.service.stage_overlay("this is not base64!!").is_err());
    }

    #[test]
    fn a_trim_may_not_name_an_overlay_outside_the_staging_directory() {
        // The paths in a trim request come from the webview and the
        // encoder opens them — the same hole `validate_id` closes for
        // capture ids.
        let h = harness();
        let elsewhere = h.captures.join("not-staged.png");
        image::RgbaImage::new(4, 4)
            .save(&elsewhere)
            .expect("written");

        let err = validate_overlays(&[OverlayRef {
            path: elsewhere.to_string_lossy().into_owned(),
            start_ms: 0,
            end_ms: 1,
        }])
        .expect_err("an unstaged overlay must be refused");
        assert!(format!("{err:?}").contains("staged"), "got {err:?}");
    }

    #[test]
    fn a_trim_with_no_overlays_needs_no_staging_directory() {
        // The staging dir is created lazily, so an ordinary trim must
        // not require it to exist.
        assert!(validate_overlays(&[]).is_ok());
    }

    // Ignored by default, like the recorder's: these need a real Media
    // Foundation platform with working H.264 encode *and* decode. Run
    // after touching the decoder, the sinks or the trim loop:
    //   cargo test -p clippity-services -- --ignored

    /// Write a real MP4 into the captures dir and return its id.
    ///
    /// Holds its own COM apartment for the writer's lifetime — the test
    /// thread has none, and `Mp4Writer` needs one before Media
    /// Foundation will open anything.
    #[cfg(target_os = "windows")]
    fn write_source_clip(dir: &std::path::Path, name: &str, seconds: u32) -> String {
        use clippity_platform::windows::media_foundation::{ComThread, Mp4Config, Mp4Writer};
        use clippity_platform::windows::nv12::PixelOrder;

        let _com = ComThread::init().expect("Media Foundation should start");

        const W: u32 = 320;
        const H: u32 = 240;
        const FPS: u32 = 30;
        let frames = FPS * seconds;
        let hns_per_frame = 10_000_000i64 / FPS as i64;

        let path = dir.join(name);
        let mut writer = Mp4Writer::create(
            &path,
            Mp4Config {
                width: W,
                height: H,
                source_width: W,
                source_height: H,
                fps: FPS,
                bitrate_bps: 1_000_000,
                keyframe_frames: FPS * 2,
                variable_bitrate: true,
                prefer_hardware: true,
                level: 31,
                audio: None,
            },
        )
        .expect("encoder available");

        let mut frame = vec![0u8; (W * H * 4) as usize];
        for index in 0..frames {
            // A ramp that changes every frame, so the encoder produces
            // real motion rather than one held keyframe.
            for pixel in frame.chunks_exact_mut(4) {
                pixel[0] = (index % 256) as u8;
                pixel[1] = 128;
                pixel[2] = 255 - (index % 256) as u8;
                pixel[3] = 255;
            }
            writer
                .write_video(
                    &frame,
                    PixelOrder::Rgba,
                    index as i64 * hns_per_frame,
                    hns_per_frame,
                )
                .expect("frame accepted");
        }
        writer.finish().expect("file closed");
        path.to_string_lossy().into_owned()
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "needs a real Media Foundation platform (encode + decode)"]
    fn a_trim_produces_a_shorter_clip_that_probes_correctly() {
        let h = harness();
        let id = write_source_clip(&h.captures, "Source.mp4", 4);

        let request = TrimRequest {
            id: id.clone(),
            start_ms: 1_000,
            end_ms: 3_000,
            format: clippity_domain::recorder::RecorderFormat::Mp4,
            fps: None,
            mute: false,
            redactions: Vec::new(),
            overlays: Vec::new(),
        };
        let result = h
            .service
            .trim(&request, &|_| {})
            .expect("the trim should encode");

        assert!(result.path.ends_with(".mp4"), "got {}", result.path);
        assert_eq!(result.duration_ms, 2_000, "the requested range");

        // The real check: read the *written file* back rather than
        // trusting what the trim said it did.
        let written = h.service.probe(&result.path).expect("the trim re-probes");
        assert_eq!((written.width, written.height), (320, 240));
        let drift = (written.duration_ms as i64 - 2_000).abs();
        assert!(drift <= 150, "trimmed clip is {} ms", written.duration_ms);

        // Non-destructive: the source is untouched.
        let source = h.service.probe(&id).expect("source still readable");
        assert!(
            source.duration_ms > 3_500,
            "source was {} ms",
            source.duration_ms
        );
    }

    /// An overlay PNG as base64: opaque green over the left half, fully
    /// transparent over the right. Stands in for what the webview's
    /// canvas produces, at the size the decoder yields.
    fn overlay_png_base64(w: u32, h: u32) -> String {
        use base64::Engine;

        let mut overlay = image::RgbaImage::new(w, h);
        for (x, _y, px) in overlay.enumerate_pixels_mut() {
            *px = if x < w / 2 {
                image::Rgba([0, 255, 0, 255])
            } else {
                image::Rgba([0, 0, 0, 0])
            };
        }
        let mut png = std::io::Cursor::new(Vec::new());
        overlay
            .write_to(&mut png, image::ImageFormat::Png)
            .expect("overlay encodes");
        base64::engine::general_purpose::STANDARD.encode(png.into_inner())
    }

    /// Decode the first frame of a clip, as RGBA.
    ///
    /// The burn-in cannot be checked any other way. Everything upstream
    /// of the encoder can be right — the request validated, the overlay
    /// staged, the progress reported — and the annotation still never
    /// reach the file, because the one thing that matters happens
    /// between the decoder and the sink.
    #[cfg(target_os = "windows")]
    fn first_frame(path: &str) -> (u32, u32, Vec<u8>) {
        use clippity_platform::windows::media_foundation::ComThread;
        use clippity_platform::windows::media_reader::Decoder;

        let _com = ComThread::init().expect("Media Foundation should start");
        let mut decoder = Decoder::open(std::path::Path::new(path), false).expect("opens");
        let frame = decoder
            .read_video()
            .expect("reads")
            .expect("the clip has a frame");
        (decoder.width(), decoder.height(), frame.rgba)
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "needs a real Media Foundation platform (encode + decode)"]
    fn an_annotated_trim_burns_the_overlay_and_redaction_into_the_file() {
        let h = harness();
        let id = write_source_clip(&h.captures, "Annotated.mp4", 3);
        let source = h.service.probe(&id).expect("probes");
        // Staged through the real path, so this covers the check that
        // the encoder only ever opens overlays this app wrote.
        let overlay = h
            .service
            .stage_overlay(&overlay_png_base64(source.width, source.height))
            .expect("overlay stages");

        let result = h
            .service
            .trim(
                &TrimRequest {
                    id,
                    start_ms: 500,
                    end_ms: 2_000,
                    format: clippity_domain::recorder::RecorderFormat::Mp4,
                    fps: None,
                    mute: false,
                    // Pixelate the whole frame. A redaction that covers
                    // everything is the one whose effect is unambiguous
                    // in a re-encoded frame, where exact colours have
                    // been through a lossy codec.
                    redactions: vec![clippity_domain::annotation::Redaction {
                        rect: clippity_domain::annotation::NormRect {
                            x: 0.0,
                            y: 0.0,
                            w: 1.0,
                            h: 1.0,
                        },
                        mode: clippity_domain::annotation::RedactionMode::Pixelate { block: 32 },
                        // Source-relative, and starting before the trim's
                        // in-point on purpose: this is what would break
                        // if the loop keyed on the output position.
                        start_ms: 0,
                        end_ms: 10_000,
                    }],
                    overlays: vec![OverlayRef {
                        path: overlay,
                        start_ms: 0,
                        end_ms: 10_000,
                    }],
                },
                &|_| {},
            )
            .expect("the annotated trim should encode");

        // Geometry and duration must be exactly what an unannotated trim
        // would produce — burning in must not resize or re-time.
        let written = h.service.probe(&result.path).expect("re-probes");
        assert_eq!(
            (written.width, written.height),
            (source.width, source.height)
        );
        let drift = (written.duration_ms as i64 - 1_500).abs();
        assert!(drift <= 150, "annotated clip is {} ms", written.duration_ms);

        let (w, _h, rgba) = first_frame(&result.path);
        let at = |x: u32| {
            let i = (x * 4) as usize;
            (rgba[i], rgba[i + 1], rgba[i + 2])
        };
        // Left half: the opaque overlay. H.264 is lossy, so this asserts
        // "overwhelmingly green" rather than an exact triple.
        let (lr, lg, lb) = at(w / 4);
        assert!(
            lg > 150 && lr < 110 && lb < 110,
            "overlay not burned in: left pixel was ({lr}, {lg}, {lb})"
        );
        // Right half: transparent overlay, so the source shows through —
        // proving the composite honoured alpha rather than painting the
        // whole frame.
        let (rr, rg, rb) = at(w - w / 4);
        assert!(
            !(rg > 150 && rr < 110 && rb < 110),
            "the transparent half was painted too: ({rr}, {rg}, {rb})"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "needs a real Media Foundation platform (encode + decode)"]
    fn a_clip_probes_from_a_thread_that_is_already_an_sta() {
        // The end-to-end half of the COM apartment fix. `media_probe` is
        // a non-async Tauri command, so it runs on the main thread —
        // which is an STA because the window and WebView require one.
        // Asking for an MTA there returns RPC_E_CHANGED_MODE, and while
        // `ComThread` now tolerates that, tolerating it is only useful
        // if the *work* then succeeds. This opens a real container from
        // an inherited STA and checks the numbers come back.
        use windows::Win32::System::Com::{
            CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
        };

        let h = harness();
        let id = write_source_clip(&h.captures, "Sta.mp4", 2);

        // Scoped, so the service can be borrowed rather than needing to
        // be shareable purely for a test's benefit.
        let probed = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    // SAFETY: a fresh thread, made an STA exactly as the
                    // app's main thread already is, balanced below.
                    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
                    assert!(hr.is_ok(), "STA setup: {hr:?}");
                    let result = h.service.probe(&id);
                    unsafe { CoUninitialize() };
                    result
                })
                .join()
                .expect("the STA thread should not panic")
        })
        .expect("a recording must open from an STA thread");

        assert_eq!((probed.width, probed.height), (320, 240));
        assert!(probed.duration_ms > 0, "duration came back as zero");
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "needs a real Media Foundation platform (encode + decode)"]
    fn a_trim_to_gif_reuses_the_same_path_and_writes_a_real_gif() {
        // The payoff of decoding into `RecordingSink` rather than
        // remuxing: the second output format costs one argument.
        let h = harness();
        let id = write_source_clip(&h.captures, "ForGif.mp4", 3);

        let result = h
            .service
            .trim(
                &TrimRequest {
                    id,
                    start_ms: 500,
                    end_ms: 1_500,
                    format: clippity_domain::recorder::RecorderFormat::Gif,
                    fps: None,
                    mute: false,
                    redactions: Vec::new(),
                    overlays: Vec::new(),
                },
                &|_| {},
            )
            .expect("the GIF trim should encode");

        assert!(result.path.ends_with(".gif"), "got {}", result.path);
        assert!(!result.has_audio, "GIF has no audio track");
        let bytes = std::fs::read(&result.path).expect("gif on disk");
        assert_eq!(&bytes[..6], b"GIF89a", "not an animated-capable GIF");
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "needs a real Media Foundation platform (encode + decode)"]
    fn progress_climbs_to_the_full_range() {
        let h = harness();
        let id = write_source_clip(&h.captures, "Progress.mp4", 3);
        let seen = std::sync::Mutex::new(Vec::new());

        h.service
            .trim(
                &TrimRequest {
                    id,
                    start_ms: 0,
                    end_ms: 2_000,
                    format: clippity_domain::recorder::RecorderFormat::Mp4,
                    fps: None,
                    mute: false,
                    redactions: Vec::new(),
                    overlays: Vec::new(),
                },
                &|p| seen.lock().unwrap().push(p),
            )
            .expect("encodes");

        let seen = seen.into_inner().unwrap();
        assert!(!seen.is_empty(), "progress was never reported");
        assert!(seen.iter().all(|p| p.total_ms == 2_000));
        let last = seen.last().unwrap();
        assert_eq!(last.encoded_ms, 2_000, "must finish at the full range");
        assert_eq!(last.fraction(), 1.0);
    }

    #[test]
    fn the_registry_is_bounded_and_evicts_oldest_first() {
        let h = harness();
        let tokens: Vec<_> = (0..MAX_LIVE_TOKENS + 3)
            .map(|i| h.service.mint(h.captures.join(format!("{i}.mp4"))))
            .collect();

        assert_eq!(h.service.live.lock().unwrap().len(), MAX_LIVE_TOKENS);
        // The three oldest aged out…
        for token in &tokens[..3] {
            assert!(
                h.service.resolve(*token).is_none(),
                "{token:?} should evict"
            );
        }
        // …and everything since is still fetchable.
        for token in &tokens[3..] {
            assert!(h.service.resolve(*token).is_some(), "{token:?} should live");
        }
    }
}
