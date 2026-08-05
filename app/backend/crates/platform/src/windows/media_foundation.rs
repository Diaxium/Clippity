//! Media Foundation MP4 sink writer — the recorder's H.264 + AAC muxer
//! (ADR 0031).
//!
//! Windows ships a hardware-accelerated H.264 encoder and an MPEG-4
//! muxer in the box, reachable through `IMFSinkWriter`. Using them costs
//! this file's worth of COM plumbing and adds nothing to the installer,
//! which is why the recorder encodes here rather than shipping an
//! FFmpeg sidecar.
//!
//! **Threading.** COM interfaces from `windows-rs` are `!Send` by
//! construction, and Media Foundation wants its callers on an
//! initialised apartment. [`Mp4Writer`] is therefore created, fed and
//! finalised on **one** thread — the recorder service's encoder thread,
//! which holds a [`ComThread`] guard for its lifetime. Nothing about a
//! writer crosses a thread boundary.
//!
//! **Crash safety.** The container is *fragmented* MP4: the muxer
//! commits self-describing fragments as it goes instead of writing the
//! index once at `Finalize`. A plain MP4 whose `moov` box never got
//! written is not a short recording, it is a zero-second one — every
//! byte is there and no player can read any of it. With fragments, a
//! process that dies mid-recording leaves a file that plays up to the
//! last committed fragment, which is the roadmap's "no recoverable
//! session loses all media" requirement.

use std::path::Path;

use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::Media::MediaFoundation::{
    eAVEncCommonRateControlMode_CBR, eAVEncCommonRateControlMode_UnconstrainedVBR,
    eAVEncH264VProfile_Main, CODECAPI_AVEncCommonRateControlMode, ICodecAPI, IMFAttributes,
    IMFMediaType, IMFSinkWriter, MFAudioFormat_AAC, MFAudioFormat_PCM, MFCreateAttributes,
    MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample, MFCreateSinkWriterFromURL,
    MFMediaType_Audio, MFMediaType_Video, MFStartup, MFTranscodeContainerType_FMPEG4,
    MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoInterlace_Progressive, MFSTARTUP_FULL,
    MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, MF_MT_AAC_PAYLOAD_TYPE,
    MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE,
    MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND,
    MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE,
    MF_MT_MAX_KEYFRAME_SPACING, MF_MT_MPEG2_LEVEL, MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO,
    MF_MT_SUBTYPE, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SINK_WRITER_DISABLE_THROTTLING,
    MF_TRANSCODE_CONTAINERTYPE, MF_VERSION,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::{VARIANT, VT_UI4};

use clippity_infra::error::{AppError, AppResult};

use super::nv12;

/// Sample rate every audio path converges on before reaching the AAC
/// encoder. Not a preference — Media Foundation's AAC encoder accepts
/// only 44.1 and 48 kHz, so WASAPI's whatever-the-device-runs-at output
/// has to be resampled to one of them, and 48 kHz is what modern
/// endpoints already use.
pub const AUDIO_SAMPLE_RATE: u32 = 48_000;
/// Channel count the mixer produces. The AAC encoder takes 1 or 2;
/// stereo preserves the left/right of system audio, and a mono mic is
/// duplicated into both rather than throwing the other channel away.
pub const AUDIO_CHANNELS: u16 = 2;
/// Bit depth of the PCM handed to the encoder. The AAC encoder's only
/// supported input depth.
pub const AUDIO_BITS_PER_SAMPLE: u32 = 16;
/// Bytes per frame of interleaved PCM (all channels, one instant).
pub const AUDIO_BLOCK_ALIGN: u32 = AUDIO_CHANNELS as u32 * (AUDIO_BITS_PER_SAMPLE / 8);
/// Encoded AAC bitrate, in **bytes** per second — the unit
/// `MF_MT_AUDIO_AVG_BYTES_PER_SECOND` wants. The encoder accepts a
/// fixed set of values; 16000 (128 kbps) is the top of it for stereo
/// AAC-LC and is transparent for speech over UI sound.
const AAC_BYTES_PER_SECOND: u32 = 16_000;
/// AAC-LC, Level 2 — the profile every player and browser decodes.
const AAC_PROFILE_LEVEL_LC: u32 = 0x29;
/// Raw AAC (no ADTS framing), which is what an MP4 container wants.
const AAC_PAYLOAD_RAW: u32 = 0;

/// Per-thread COM apartment guard.
///
/// `CoUninitialize` on drop keeps the apartment's lifetime tied to the
/// thread's, so an encoder thread that exits early (a failed start, a
/// panic) doesn't leave an initialised apartment behind on a thread the
/// runtime may reuse.
pub struct ComThread {
    /// Whether this guard owes a `CoUninitialize`.
    ///
    /// True for every call that *succeeded*, which includes `S_FALSE` —
    /// see [`ComThread::init`] on why that one is easy to get wrong in
    /// the direction of a leak.
    balance: bool,
}

impl ComThread {
    /// Join a COM apartment and start Media Foundation.
    ///
    /// # The three outcomes, and why each is handled the way it is
    ///
    /// `CoInitializeEx` answers in three ways, and treating any of them
    /// as another is a real bug rather than a stylistic choice.
    ///
    /// - **`S_OK`** — this call created the apartment. It must be
    ///   balanced by `CoUninitialize`.
    /// - **`S_FALSE`** — the thread was already in the *same* kind of
    ///   apartment. This is a **success**, and it still took a
    ///   reference: the documented rule is one `CoUninitialize` per
    ///   successful `CoInitializeEx`, `S_FALSE` included. Reading it as
    ///   "someone else owns this, leave it alone" leaks the apartment
    ///   for the life of the thread.
    /// - **`RPC_E_CHANGED_MODE`** — the thread is already in an
    ///   apartment of the *other* kind. No reference was taken, so this
    ///   one must **not** be balanced.
    ///
    /// # Why a changed mode is not a failure
    ///
    /// It used to be, and that is the bug this comment exists for.
    /// Non-async Tauri commands run on the main thread, which is already
    /// an STA because the window and the WebView require one — so
    /// `media_probe` asking for an MTA got `RPC_E_CHANGED_MODE` and
    /// opening any recording in Studio failed with a COM error blaming
    /// the recorder. `list_audio_devices` had the same latent fault.
    ///
    /// The thread is in a usable apartment either way; we simply did not
    /// choose which. Refusing to proceed turns "COM is already set up,
    /// differently" into "this feature does not work", which is the
    /// wrong trade for every caller.
    ///
    /// # MTA is still what the encoders get
    ///
    /// The preference for MTA is real: nothing here pumps a message
    /// loop, and an STA Media Foundation caller that never dispatches
    /// messages can deadlock when the encoder marshals a call back. That
    /// guarantee is preserved by *where the encoders run* rather than by
    /// failing here — `media_trim` and the recorder both encode on their
    /// own threads (`spawn_blocking` and the recorder worker), which
    /// start with no apartment and therefore get the MTA they ask for.
    ///
    /// What lands in an inherited STA is the short, synchronous work:
    /// probing a container's headers and enumerating audio endpoints.
    /// Neither registers a callback, so neither has anything to marshal
    /// back and nothing to deadlock on.
    pub fn init() -> AppResult<Self> {
        // SAFETY: no preconditions.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };

        let balance = if hr == RPC_E_CHANGED_MODE {
            false
        } else if hr.is_err() {
            return Err(AppError::Recorder(format!(
                "COM init failed: {hr:?} — Media Foundation is unreachable"
            )));
        } else {
            // S_OK and S_FALSE alike.
            true
        };

        ensure_platform()?;
        Ok(Self { balance })
    }
}

impl Drop for ComThread {
    fn drop(&mut self) {
        if self.balance {
            // SAFETY: balances the CoInitializeEx above, on the same
            // thread, exactly once.
            unsafe { CoUninitialize() };
        }
    }
}

/// Start the Media Foundation platform once per process.
///
/// Deliberately never paired with `MFShutdown`: shutdown is
/// process-wide, so calling it when one recording ends would pull the
/// platform out from under any other MF user in the app — the Grab-Text
/// mode's `Windows.Media.Ocr` among them. The platform is cheap to leave
/// running and the process teardown reclaims it.
fn ensure_platform() -> AppResult<()> {
    use std::sync::OnceLock;
    static STARTED: OnceLock<Result<(), String>> = OnceLock::new();

    STARTED
        .get_or_init(|| {
            // SAFETY: MF_VERSION is the version this binary was compiled
            // against; MFSTARTUP_FULL is the standard full-platform mode.
            unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.map_err(|e| e.to_string())
        })
        .clone()
        .map_err(|e| AppError::Recorder(format!("Media Foundation unavailable: {e}")))
}

/// PCM audio shape handed to [`Mp4Writer::write_audio`]. Fixed by the
/// AAC encoder's constraints — see the `AUDIO_*` constants — so this
/// carries no fields; it exists to make "this recording has audio"
/// explicit at the call site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioTrack;

/// Everything the writer needs to describe its output.
#[derive(Debug, Clone, Copy)]
pub struct Mp4Config {
    /// Encoded frame size — what ends up in the file.
    pub width: u32,
    pub height: u32,
    /// Size of the frames the caller will hand to
    /// [`Mp4Writer::write_video`]. Equal to `width`/`height` unless a
    /// resolution cap is in play, in which case the sink writer inserts
    /// its Video Processor MFT and scales on the way to the encoder.
    ///
    /// Doing it here rather than resizing each frame in Rust is worth
    /// the extra field: the processor is SIMD/GPU-backed, and a CPU box
    /// filter over a 4K frame does not fit in a 60 fps budget — the
    /// setting meant to make recording cheaper would have made it drop
    /// frames.
    pub source_width: u32,
    pub source_height: u32,
    pub fps: u32,
    pub bitrate_bps: u32,
    /// Frames between keyframes, for `MF_MT_MAX_KEYFRAME_SPACING`.
    /// Resolved by `domain::recorder::keyframe_interval_frames` so the
    /// seconds-to-frames conversion stays testable without COM.
    pub keyframe_frames: u32,
    /// Let the encoder vary its bitrate over time. See
    /// [`Mp4Writer::apply_rate_control`] for why this is best-effort.
    pub variable_bitrate: bool,
    /// Prefer the GPU's encoder. `false` forces Media Foundation's
    /// software H.264 encoder — the escape hatch for a driver whose
    /// output looks wrong.
    pub prefer_hardware: bool,
    /// H.264 level, as the level-times-ten code `MF_MT_MPEG2_LEVEL`
    /// takes. Resolved by `domain::recorder::h264_level` — the caller
    /// supplies it rather than this module deriving it, so the spec
    /// table stays testable without Media Foundation.
    pub level: u32,
    /// `Some` adds an AAC stream. A recording with no audio must have
    /// **no** audio stream rather than a silent one — a zero-sample
    /// track makes some players report a broken file.
    pub audio: Option<AudioTrack>,
}

/// An open MP4 file being written. See the module docs for the
/// single-thread requirement.
pub struct Mp4Writer {
    writer: IMFSinkWriter,
    video_stream: u32,
    audio_stream: Option<u32>,
    /// Geometry of the frames [`Mp4Writer::write_video`] expects, which
    /// is the *negotiated* input size — not necessarily the one asked
    /// for. See [`Mp4Writer::input_size`].
    width: u32,
    height: u32,
    /// Size of one NV12 frame, computed once from the negotiated
    /// geometry. Not a buffer: frames are converted straight into the
    /// Media Foundation sample — see [`Mp4Writer::write_video`].
    nv12_len: usize,
    finalized: bool,
}

impl Mp4Writer {
    /// Create the file and negotiate both streams. The file exists (and
    /// is a valid, empty fragmented MP4) as soon as this returns.
    pub fn create(path: &Path, config: Mp4Config) -> AppResult<Self> {
        if config.width == 0 || config.height == 0 || config.source_width == 0 {
            return Err(AppError::Recorder("recording has zero area".into()));
        }
        for (w, h) in [
            (config.width, config.height),
            (config.source_width, config.source_height),
        ] {
            if w % 2 != 0 || h % 2 != 0 {
                // `domain::recorder::even_dimensions` is supposed to have
                // handled this; failing loudly beats emitting a sheared file.
                return Err(AppError::Recorder(format!(
                    "H.264 needs even dimensions, got {w}×{h}"
                )));
            }
        }

        let attributes = sink_attributes(config.prefer_hardware)?;

        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        // SAFETY: `wide` is a NUL-terminated UTF-16 buffer that outlives
        // the call; the byte-stream argument is optional and the
        // attribute store is a valid IMFAttributes.
        let writer = unsafe { MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, &attributes) }
            .map_err(|e| {
                AppError::Recorder(format!(
                    "could not open {} for writing: {e}",
                    path.display()
                ))
            })?;

        let (video_stream, input) = add_video_stream(&writer, &config)?;
        // Before BeginWriting: the encoder MFT accepts codec settings
        // only while the writer is still in its configuration phase.
        apply_rate_control(&writer, video_stream, config.variable_bitrate);
        let audio_stream = match config.audio {
            Some(_) => Some(add_audio_stream(&writer)?),
            None => None,
        };

        // SAFETY: both streams are fully configured; BeginWriting is the
        // documented transition out of the configuration phase.
        unsafe { writer.BeginWriting() }
            .map_err(|e| AppError::Recorder(format!("encoder would not start: {e}")))?;

        Ok(Self {
            writer,
            video_stream,
            audio_stream,
            width: input.0,
            height: input.1,
            nv12_len: nv12::nv12_len(input.0, input.1),
            finalized: false,
        })
    }

    /// Whether this writer has an audio stream to feed.
    pub fn has_audio(&self) -> bool {
        self.audio_stream.is_some()
    }

    /// Frame size [`Self::write_video`] expects.
    ///
    /// Usually `Mp4Config::source_{width,height}`, but not always: when
    /// a resolution cap asked the sink writer to scale and the machine's
    /// encoder chain would not, this falls back to the *output* size and
    /// the caller has to resize frames itself. Exposed rather than
    /// asserted so a session on such a machine still honours the setting
    /// instead of failing at the moment Record was pressed.
    pub fn input_size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Encode one frame at `timestamp_hns`, lasting `duration_hns`.
    ///
    /// `order` states the source's channel byte order — `xcap` produces
    /// RGBA, raw Win32 surfaces produce BGRA, and guessing swaps red
    /// with blue (see [`nv12::PixelOrder`]).
    ///
    /// Timestamps come from the session's wall clock rather than a frame
    /// counter — see `domain::recorder::hns_from_millis` for why.
    ///
    /// **The conversion writes straight into the sample's buffer.** A
    /// scratch `Vec` used to sit in between, converted into and then
    /// copied across, which meant every frame crossed an extra 11 MiB at
    /// 5120x1440 — a millisecond of pure memory traffic, per frame, to
    /// move bytes that were already in their final form. The buffer has
    /// to be a fresh Media Foundation one (the sink writer keeps a
    /// reference for as long as the encoder needs it, so it cannot be
    /// pooled), but nothing required the conversion to happen anywhere
    /// else first.
    pub fn write_video(
        &mut self,
        pixels: &[u8],
        order: nv12::PixelOrder,
        timestamp_hns: i64,
        duration_hns: i64,
    ) -> AppResult<()> {
        let geometry = || {
            AppError::Recorder(format!(
                "frame does not match the recording geometry ({}×{})",
                self.width, self.height
            ))
        };
        // Checked before a buffer is allocated for it: a mis-sized frame
        // should cost nothing, and `to_nv12` refusing after the fact
        // would leave an uninitialised sample to unwind past.
        if pixels.len() < self.width as usize * self.height as usize * 4 {
            return Err(geometry());
        }

        let (width, height) = (self.width, self.height);
        let sample = build_sample(self.nv12_len, timestamp_hns, duration_hns, |dst| {
            nv12::to_nv12(pixels, dst, width, height, order)
                .then_some(())
                .ok_or_else(geometry)
        })?;
        // SAFETY: the stream index came from AddStream on this writer and
        // the sample holds a buffer of the negotiated NV12 size.
        unsafe { self.writer.WriteSample(self.video_stream, &sample) }
            .map_err(|e| AppError::Recorder(format!("video frame rejected: {e}")))
    }

    /// Encode a run of interleaved 16-bit PCM at [`AUDIO_SAMPLE_RATE`].
    ///
    /// A no-op when the file has no audio stream, so a caller whose
    /// microphone vanished mid-session can keep pushing whatever the
    /// mixer produces without branching.
    pub fn write_audio(
        &mut self,
        pcm: &[u8],
        timestamp_hns: i64,
        duration_hns: i64,
    ) -> AppResult<()> {
        let Some(stream) = self.audio_stream else {
            return Ok(());
        };
        if pcm.is_empty() {
            return Ok(());
        }
        // A plain copy here: an audio packet is a few kilobytes, so
        // there is nothing to save by converting in place, and the PCM
        // arrives already in its final form.
        let sample = build_sample(pcm.len(), timestamp_hns, duration_hns, |dst| {
            dst.copy_from_slice(pcm);
            Ok(())
        })?;
        // SAFETY: as above — a configured stream index and a valid sample.
        unsafe { self.writer.WriteSample(stream, &sample) }
            .map_err(|e| AppError::Recorder(format!("audio rejected: {e}")))
    }

    /// Tell the muxer a stream has no data for a stretch of the
    /// timeline, so it doesn't stall waiting to interleave.
    ///
    /// Needed whenever video and audio advance at different rates — a
    /// paused-then-resumed session, or a static screen the capture
    /// source produced no frames for. Without it the sink writer holds
    /// samples from the *other* stream indefinitely, and the recording's
    /// audio drifts ahead of its video.
    pub fn mark_gap(&self, timestamp_hns: i64) -> AppResult<()> {
        // SAFETY: valid stream index on a writer that has begun writing.
        unsafe { self.writer.SendStreamTick(self.video_stream, timestamp_hns) }
            .map_err(|e| AppError::Recorder(format!("stream tick rejected: {e}")))
    }

    /// Flush the encoder and close the container. Consumes the writer —
    /// there is nothing useful to do with one afterwards.
    pub fn finish(mut self) -> AppResult<()> {
        self.finalize_once()
    }

    fn finalize_once(&mut self) -> AppResult<()> {
        if self.finalized {
            return Ok(());
        }
        self.finalized = true;
        // SAFETY: the writer has begun writing and is finalized once.
        unsafe { self.writer.Finalize() }
            .map_err(|e| AppError::Recorder(format!("could not close the recording: {e}")))
    }
}

impl Drop for Mp4Writer {
    /// Finalize on the way out if the caller didn't.
    ///
    /// The `?` on any `write_video` propagates out of the encoder loop
    /// and drops the writer; without this, the fragments already on disk
    /// would be missing their trailer. Best-effort and logged rather
    /// than panicking — this runs on an unwind path.
    fn drop(&mut self) {
        if let Err(e) = self.finalize_once() {
            tracing::warn!("recording not finalized cleanly: {e}");
        }
    }
}

/// Run a block of COM calls, turning the first failure into one
/// `AppError::Recorder` labelled with what was being configured.
///
/// Media Foundation reports everything as an `HRESULT`, and a bare
/// `0x80070057 E_INVALIDARG` from a wall of attribute writes says
/// nothing about which one. Grouping each media type's setup under a
/// label is the difference between a debuggable log line and a hex
/// code — and it keeps `?` usable inside the block, since the closure
/// returns Media Foundation's own `Result`.
fn configure(label: &'static str, f: impl FnOnce() -> windows::core::Result<()>) -> AppResult<()> {
    f().map_err(|e| AppError::Recorder(format!("{label}: {e}")))
}

/// Attributes for the sink writer itself (as opposed to either stream).
fn sink_attributes(prefer_hardware: bool) -> AppResult<IMFAttributes> {
    let mut store: Option<IMFAttributes> = None;
    // SAFETY: out-pointer to a local Option, initial size is a hint.
    unsafe { MFCreateAttributes(&mut store, 4) }
        .map_err(|e| AppError::Recorder(format!("attribute store: {e}")))?;
    let attributes =
        store.ok_or_else(|| AppError::Recorder("attribute store came back empty".into()))?;

    configure("sink writer attributes", || {
        // SAFETY: every key below is a documented sink-writer attribute
        // and the value types match what each expects.
        unsafe {
            // Let the GPU's encoder do the work when there is one. On a
            // machine without it MF falls back to the software encoder
            // transparently — this is a preference, not a requirement.
            //
            // Turning it *off* is a real setting rather than a debug
            // knob: a handful of drivers encode visibly worse than the
            // software path at the same bitrate, and nothing here can
            // detect that. Software encode cannot keep up at 4K60, which
            // is why the default stays on.
            attributes.SetUINT32(
                &MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
                u32::from(prefer_hardware),
            )?;
            // Leave throttling ON (0 = do not disable). Throttling is
            // what makes `WriteSample` block once the encoder falls
            // behind, which is the backpressure the capture worker
            // needs: disabled, a recording the encoder can't keep up
            // with grows a queue in RAM until the process dies, instead
            // of dropping frames.
            attributes.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 0)?;
            // Fragmented MP4 — see the module docs on crash safety.
            attributes.SetGUID(
                &MF_TRANSCODE_CONTAINERTYPE,
                &MFTranscodeContainerType_FMPEG4,
            )?;
        }
        Ok(())
    })?;
    Ok(attributes)
}

/// Declare the H.264 output type, then the NV12 input type feeding it.
///
/// Returns the stream index and the input geometry that was actually
/// accepted — see [`Mp4Writer::input_size`] for why those can differ
/// from what was asked for.
fn add_video_stream(writer: &IMFSinkWriter, config: &Mp4Config) -> AppResult<(u32, (u32, u32))> {
    let out = new_media_type()?;
    configure("H.264 output type", || {
        let attrs: &IMFAttributes = (&out).into();
        // SAFETY: standard H.264 output type keys and value types.
        unsafe {
            attrs.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            attrs.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            attrs.SetUINT32(&MF_MT_AVG_BITRATE, config.bitrate_bps)?;
            attrs.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            // Main profile: the widest-compatibility choice that still
            // gets B-frames and CABAC. High would compress a little
            // better; Baseline would play on hardware nobody has.
            attrs.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main.0 as u32)?;
            // Stated, not inferred. Left unset, several hardware
            // encoders pick a level too small for an ultrawide frame
            // and then reject the media type — see
            // `domain::recorder::h264_level`. The value is the level
            // times ten, which is exactly how `eAVEncH264VLevel` is
            // numbered, so the codes travel as plain integers rather
            // than dragging that enum into the domain crate (which also
            // stops at 5.2 in the `windows` bindings, below what a
            // 5120×2160 panel needs).
            attrs.SetUINT32(&MF_MT_MPEG2_LEVEL, config.level)?;
            attrs.SetUINT64(&MF_MT_FRAME_SIZE, pack(config.width, config.height))?;
            attrs.SetUINT64(&MF_MT_FRAME_RATE, pack(config.fps, 1))?;
            attrs.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            // A decoder can only start at a keyframe, so this is the
            // granularity Studio's scrubber can seek to. Left unset the
            // encoders pick wildly different values — some default to
            // several hundred frames, which makes a fresh recording feel
            // broken to scrub.
            attrs.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, config.keyframe_frames.max(1))?;
        }
        Ok(())
    })?;
    // SAFETY: a fully-populated output media type.
    let stream = unsafe { writer.AddStream(&out) }
        .map_err(|e| AppError::Recorder(format!("no H.264 encoder available: {e}")))?;

    // Try the capture size first. When it differs from the output size
    // the sink writer resolves the mismatch by loading its Video
    // Processor MFT, which is how a resolution cap gets applied without
    // this process touching a pixel.
    let source = (config.source_width, config.source_height);
    let out = (config.width, config.height);
    match set_video_input(writer, stream, config, source) {
        Ok(()) => Ok((stream, source)),
        // Nothing to fall back to when no scaling was asked for: the
        // encoder refused the only geometry there is.
        Err(e) if source == out => Err(e),
        // No usable processor on this machine (rare, but it happens on
        // stripped-down installs and some remote-desktop sessions).
        // Declare the input at the output size and let the sink
        // downscale in Rust: slower, and still the setting the user
        // asked for.
        Err(_) => set_video_input(writer, stream, config, out).map(|()| (stream, out)),
    }
}

/// Ask the encoder MFT to vary (or hold) its bitrate over time.
///
/// **Best-effort, and deliberately not an error.** Rate control is not a
/// media-type attribute — it lives on the encoder's `ICodecAPI`, reached
/// through the sink writer's `GetServiceForStream`, and not every
/// encoder exposes one or accepts this property. A machine where it
/// fails still produces a correct file at the declared
/// `MF_MT_AVG_BITRATE`; it simply spends those bits the way its encoder
/// chose to. Refusing to record over a tuning preference would be the
/// wrong trade, so this logs and returns.
///
/// `UnconstrainedVBR` rather than one of the peak-constrained modes:
/// the point is to let long motionless stretches — which is most of a
/// screen recording — cost almost nothing, and a peak constraint gives
/// that saving back.
fn apply_rate_control(writer: &IMFSinkWriter, stream: u32, variable: bool) {
    let mode = if variable {
        eAVEncCommonRateControlMode_UnconstrainedVBR
    } else {
        eAVEncCommonRateControlMode_CBR
    };

    let mut raw: *mut core::ffi::c_void = std::ptr::null_mut();
    // SAFETY: `stream` came from AddStream on this writer; the service
    // GUID is GUID_NULL (the documented "the stream's own encoder"
    // value) and `raw` receives an ICodecAPI the block below owns.
    let got = unsafe {
        writer.GetServiceForStream(
            stream,
            &windows::core::GUID::zeroed(),
            &ICodecAPI::IID,
            &mut raw,
        )
    };
    if got.is_err() || raw.is_null() {
        tracing::debug!("encoder exposes no ICodecAPI; leaving its default rate control");
        return;
    }
    // SAFETY: `GetServiceForStream` returned S_OK with a non-null
    // pointer to an ICodecAPI, and `from_raw` takes ownership of the
    // reference it already added.
    let codec: ICodecAPI = unsafe { ICodecAPI::from_raw(raw) };

    let value = u32_variant(mode.0 as u32);
    // SAFETY: the property takes a VT_UI4, which is what `u32_variant`
    // builds, and both pointers outlive the call.
    let set = unsafe { codec.SetValue(&CODECAPI_AVEncCommonRateControlMode, &value) };
    if let Err(e) = set {
        tracing::debug!("encoder refused the rate-control mode, using its default: {e}");
    }
}

/// A `VT_UI4` VARIANT.
///
/// Built by hand because `windows` 0.62 has no `From<u32> for VARIANT`,
/// and the alternative — `InitVariantFromUInt32` out of propsys — would
/// pull in another import for the same four stores.
fn u32_variant(value: u32) -> VARIANT {
    let mut variant = VARIANT::default();
    // SAFETY: writing the union's UI4 arm and tagging `vt` to match, on
    // a zeroed VARIANT. VT_UI4 owns nothing, so there is nothing to
    // clear when it drops.
    unsafe {
        let inner = &mut *variant.Anonymous.Anonymous;
        inner.vt = VT_UI4;
        inner.Anonymous.ulVal = value;
    }
    variant
}

/// Set the stream's uncompressed input type at `size`.
fn set_video_input(
    writer: &IMFSinkWriter,
    stream: u32,
    config: &Mp4Config,
    size: (u32, u32),
) -> AppResult<()> {
    let input = new_media_type()?;
    configure("NV12 input type", || {
        let attrs: &IMFAttributes = (&input).into();
        // SAFETY: matching uncompressed input type. The frame rate must
        // agree with the output type; the frame *size* need not, and a
        // mismatch is what asks for the scaler.
        unsafe {
            attrs.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            attrs.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            attrs.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            // Every uncompressed frame stands alone — lets the encoder
            // skip the "is this a delta frame?" question per sample.
            attrs.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
            attrs.SetUINT64(&MF_MT_FRAME_SIZE, pack(size.0, size.1))?;
            attrs.SetUINT64(&MF_MT_FRAME_RATE, pack(config.fps, 1))?;
            attrs.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        }
        Ok(())
    })?;
    // SAFETY: `stream` was returned by AddStream on this writer.
    unsafe { writer.SetInputMediaType(stream, &input, None) }
        .map_err(|e| AppError::Recorder(format!("encoder rejected the frame format: {e}")))
}

/// Declare the AAC output type and its PCM input.
fn add_audio_stream(writer: &IMFSinkWriter) -> AppResult<u32> {
    let out = new_media_type()?;
    configure("AAC output type", || {
        let attrs: &IMFAttributes = (&out).into();
        // SAFETY: documented AAC encoder output keys. Sample rate,
        // channel count and depth are constrained by the encoder — see
        // the AUDIO_* constants.
        unsafe {
            attrs.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            attrs.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
            attrs.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, AUDIO_BITS_PER_SAMPLE)?;
            attrs.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, AUDIO_SAMPLE_RATE)?;
            attrs.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, AUDIO_CHANNELS as u32)?;
            attrs.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AAC_BYTES_PER_SECOND)?;
            attrs.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, AAC_PAYLOAD_RAW)?;
            attrs.SetUINT32(
                &MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION,
                AAC_PROFILE_LEVEL_LC,
            )?;
        }
        Ok(())
    })?;
    // SAFETY: a fully-populated output media type.
    let stream = unsafe { writer.AddStream(&out) }
        .map_err(|e| AppError::Recorder(format!("no AAC encoder available: {e}")))?;

    let input = new_media_type()?;
    configure("PCM input type", || {
        let attrs: &IMFAttributes = (&input).into();
        // SAFETY: matching uncompressed PCM input type.
        unsafe {
            attrs.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            attrs.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
            attrs.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, AUDIO_BITS_PER_SAMPLE)?;
            attrs.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, AUDIO_SAMPLE_RATE)?;
            attrs.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, AUDIO_CHANNELS as u32)?;
            attrs.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, AUDIO_BLOCK_ALIGN)?;
            attrs.SetUINT32(
                &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
                AUDIO_SAMPLE_RATE * AUDIO_BLOCK_ALIGN,
            )?;
        }
        Ok(())
    })?;
    // SAFETY: `stream` was just returned by AddStream on this writer.
    unsafe { writer.SetInputMediaType(stream, &input, None) }
        .map_err(|e| AppError::Recorder(format!("encoder rejected the audio format: {e}")))?;

    Ok(stream)
}

fn new_media_type() -> AppResult<IMFMediaType> {
    // SAFETY: no arguments, returns a fresh empty media type.
    unsafe { MFCreateMediaType() }.map_err(|e| AppError::Recorder(format!("media type: {e}")))
}

/// Build a fresh MF sample of `len` bytes, let `fill` write it, and
/// stamp its place on the timeline.
///
/// A new buffer per sample rather than a pooled one: the sink writer
/// keeps a reference for as long as the encoder needs it, so reusing a
/// buffer would overwrite data still queued for encode.
///
/// `fill` receives the buffer's bytes directly. That is what lets the
/// NV12 conversion land in its final home rather than being converted
/// somewhere else and copied in — see [`Mp4Writer::write_video`]. A
/// `fill` that fails leaves the buffer unpublished and the sample is
/// dropped, so a refused frame writes nothing.
fn build_sample(
    len: usize,
    timestamp_hns: i64,
    duration_hns: i64,
    fill: impl FnOnce(&mut [u8]) -> AppResult<()>,
) -> AppResult<windows::Win32::Media::MediaFoundation::IMFSample> {
    let requested = u32::try_from(len)
        .map_err(|_| AppError::Recorder(format!("a {len}-byte sample is too large")))?;
    // SAFETY: a positive length; returns an owned buffer.
    let buffer = unsafe { MFCreateMemoryBuffer(requested) }
        .map_err(|e| AppError::Recorder(format!("sample buffer: {e}")))?;

    // SAFETY: Lock hands back a pointer to at least `len` writable bytes
    // (the length just requested, which `MFCreateMemoryBuffer` allocated
    // and `Lock` reports through `max_len`). The slice is confined to
    // this block and Unlock is called on every path out of it, including
    // the one where `fill` returns an error.
    unsafe {
        let mut dst: *mut u8 = std::ptr::null_mut();
        let mut max_len: u32 = 0;
        buffer
            .Lock(&mut dst, Some(&mut max_len), None)
            .map_err(|e| AppError::Recorder(format!("sample buffer lock: {e}")))?;
        let filled = if dst.is_null() || (max_len as usize) < len {
            Err(AppError::Recorder(format!(
                "sample buffer came back {max_len} bytes for a {len}-byte frame"
            )))
        } else {
            fill(std::slice::from_raw_parts_mut(dst, len))
        };
        buffer
            .Unlock()
            .map_err(|e| AppError::Recorder(format!("sample buffer unlock: {e}")))?;
        filled?;
        buffer
            .SetCurrentLength(requested)
            .map_err(|e| AppError::Recorder(format!("sample length: {e}")))?;
    }

    // SAFETY: a fresh sample; the buffer above is valid and owned.
    let sample =
        unsafe { MFCreateSample() }.map_err(|e| AppError::Recorder(format!("sample: {e}")))?;
    unsafe {
        sample
            .AddBuffer(&buffer)
            .map_err(|e| AppError::Recorder(format!("sample buffer attach: {e}")))?;
        sample
            .SetSampleTime(timestamp_hns)
            .map_err(|e| AppError::Recorder(format!("sample time: {e}")))?;
        sample
            .SetSampleDuration(duration_hns)
            .map_err(|e| AppError::Recorder(format!("sample duration: {e}")))?;
    }
    Ok(sample)
}

/// Pack a pair of 32-bit values into the single `UINT64` that Media
/// Foundation uses for sizes and ratios.
///
/// The SDK exposes `MFSetAttributeSize` / `MFSetAttributeRatio` for
/// this, but they are C inline functions in `mfapi.h` — there is no
/// export for `windows-rs` to bind, so the packing is done here. High
/// 32 bits first: width before height, numerator before denominator.
fn pack(high: u32, low: u32) -> u64 {
    ((high as u64) << 32) | low as u64
}

use std::os::windows::ffi::OsStrExt;

#[cfg(test)]
mod tests {
    use super::*;

    // The COM surface can't be exercised without a real MF pipeline, so
    // what is testable here is the pure packing helper every media type
    // depends on — an inverted `pack` yields a recording with its width
    // and height swapped, which negotiates fine and looks broken.

    #[test]
    fn pack_puts_the_first_value_in_the_high_word() {
        assert_eq!(pack(1920, 1080), (1920u64 << 32) | 1080);
        assert_eq!(pack(1, 1), (1u64 << 32) | 1);
        assert_eq!(pack(30, 1) >> 32, 30);
        assert_eq!(pack(30, 1) & 0xFFFF_FFFF, 1);
    }

    #[test]
    fn pack_survives_the_full_u32_range() {
        assert_eq!(pack(u32::MAX, u32::MAX), u64::MAX);
        assert_eq!(pack(0, 0), 0);
    }

    /// End-to-end encode against the real platform encoders.
    ///
    /// `#[ignore]`d because it needs a Windows session with H.264 and
    /// AAC encoders present — true on any normal desktop, not
    /// guaranteed on a bare Server SKU or a container, where it would
    /// be a spurious failure rather than a regression. Run it with
    /// `cargo test -p clippity-platform -- --ignored` after touching
    /// anything in this file: media-type negotiation is the part that
    /// compiles perfectly and then fails at runtime.
    #[test]
    #[ignore = "needs a Windows session with Media Foundation encoders"]
    fn encodes_a_playable_mp4_with_both_streams() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let _com = ComThread::init().expect("COM + Media Foundation start");

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("clippity-mf-{stamp}.mp4"));

        let (width, height, fps) = (320u32, 240u32, 30u32);
        let mut writer = Mp4Writer::create(
            &path,
            Mp4Config {
                width,
                height,
                source_width: width,
                source_height: height,
                fps,
                bitrate_bps: 2_000_000,
                keyframe_frames: fps * 2,
                variable_bitrate: true,
                prefer_hardware: true,
                level: 42,
                audio: Some(AudioTrack),
            },
        )
        .expect("sink writer accepts the negotiated media types");
        assert!(writer.has_audio());

        // One second of video: a moving band, so the encoder has real
        // inter-frame motion to compress rather than a static colour
        // that would compress to almost nothing and hide a broken
        // pixel path.
        let frame_dur = 10_000_000i64 / fps as i64;
        let mut bgra = vec![0u8; (width * height * 4) as usize];
        for i in 0..fps {
            let band = (i * height / fps) as usize;
            for (row, chunk) in bgra.chunks_mut((width * 4) as usize).enumerate() {
                let value = if row == band { 255 } else { 32 };
                for px in chunk.chunks_mut(4) {
                    px[0] = value;
                    px[1] = value;
                    px[2] = value;
                    px[3] = 255;
                }
            }
            writer
                .write_video(
                    &bgra,
                    nv12::PixelOrder::Bgra,
                    frame_dur * i as i64,
                    frame_dur,
                )
                .expect("video frame accepted");
        }

        // A second of silence at the negotiated PCM format.
        let bytes_per_second = (AUDIO_SAMPLE_RATE * AUDIO_BLOCK_ALIGN) as usize;
        let silence = vec![0u8; bytes_per_second];
        writer
            .write_audio(&silence, 0, 10_000_000)
            .expect("audio accepted");

        writer.finish().expect("finalize");

        let size = std::fs::metadata(&path).expect("file exists").len();
        assert!(
            size > 1_024,
            "expected real encoded output, got {size} bytes"
        );

        // Sanity-check the container: every MP4 starts with a box whose
        // type is `ftyp`, at offset 4.
        let head = std::fs::read(&path).expect("read back");
        assert_eq!(&head[4..8], b"ftyp", "not an MP4 container");

        let _ = std::fs::remove_file(&path);
    }

    /// Every encoder-settings combination, against the real encoders.
    ///
    /// The keyframe spacing and the hardware preference are media-type
    /// and attribute-store values, so a machine that dislikes one fails
    /// at *negotiation* — "no H.264 encoder available" the instant the
    /// user presses Record. Rate control is different: it is applied
    /// through `ICodecAPI` and is allowed to fail silently, so what this
    /// asserts is that trying it never breaks the writer.
    ///
    /// Ignored for the same reason as the tests above — it needs real
    /// encoders present. Note the software-encoder case: forcing
    /// `prefer_hardware: false` is the one path a GPU-equipped dev
    /// machine otherwise never exercises.
    #[test]
    #[ignore = "needs a Windows session with Media Foundation encoders"]
    fn every_encoder_setting_combination_negotiates() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let _com = ComThread::init().expect("COM + Media Foundation start");
        let (width, height, fps) = (320u32, 240u32, 30u32);

        for (index, (variable, hardware, keyframe_seconds)) in [
            (true, true, 2u32),
            (false, true, 2),
            (true, false, 2),
            // The bounds of the settable interval, since spacing is what
            // the media type actually carries.
            (true, true, 1),
            (true, true, 10),
        ]
        .into_iter()
        .enumerate()
        {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!("clippity-mf-enc-{stamp}-{index}.mp4"));

            let mut writer = Mp4Writer::create(
                &path,
                Mp4Config {
                    width,
                    height,
                    source_width: width,
                    source_height: height,
                    fps,
                    bitrate_bps: 2_000_000,
                    keyframe_frames: keyframe_seconds * fps,
                    variable_bitrate: variable,
                    prefer_hardware: hardware,
                    level: 42,
                    audio: None,
                },
            )
            .unwrap_or_else(|e| {
                panic!("vbr={variable} hw={hardware} keyframes={keyframe_seconds}s rejected: {e}")
            });

            let frame_dur = 10_000_000i64 / fps as i64;
            let bgra = vec![64u8; (width * height * 4) as usize];
            for i in 0..fps {
                writer
                    .write_video(
                        &bgra,
                        nv12::PixelOrder::Bgra,
                        frame_dur * i as i64,
                        frame_dur,
                    )
                    .expect("video frame accepted");
            }
            writer.finish().expect("finalize");

            let size = std::fs::metadata(&path).expect("file exists").len();
            assert!(
                size > 512,
                "vbr={variable} hw={hardware} produced {size} bytes"
            );
            let _ = std::fs::remove_file(&path);
        }
    }

    /// The ultrawide guard, against the real encoder.
    ///
    /// 5120×2160 is past H.264 level 5.2's `MaxFS` and well past the
    /// 4096 px width several hardware encoders will infer a level for.
    /// This is the case that failed as "no H.264 encoder available" at
    /// the moment the user pressed Record, so it is worth a live check
    /// rather than only a unit test of the level table.
    ///
    /// Ignored for the same reason as the test above, plus one more: it
    /// allocates an 11-megapixel NV12 scratch buffer.
    #[test]
    #[ignore = "needs a Windows session with Media Foundation encoders"]
    fn accepts_an_ultrawide_frame_size() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let _com = ComThread::init().expect("COM + Media Foundation start");

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("clippity-mf-uw-{stamp}.mp4"));

        let (width, height, fps) = (5_120u32, 2_160u32, 60u32);
        let mut writer = Mp4Writer::create(
            &path,
            Mp4Config {
                width,
                height,
                source_width: width,
                source_height: height,
                fps,
                bitrate_bps: 46_000_000,
                keyframe_frames: fps * 2,
                variable_bitrate: true,
                prefer_hardware: true,
                // What `domain::recorder::h264_level` resolves for this
                // frame; hard-coded here so the two crates' agreement is
                // asserted rather than assumed.
                level: 60,
                audio: None,
            },
        )
        .expect("encoder accepts a 5120×2160 media type");

        // One frame is enough — negotiation is what breaks, not the
        // steady state, and a second of 4K-plus video is a slow test.
        let bgra = vec![0u8; (width as usize) * (height as usize) * 4];
        writer
            .write_video(&bgra, nv12::PixelOrder::Bgra, 0, 10_000_000 / fps as i64)
            .expect("ultrawide frame accepted");
        writer.finish().expect("finalize");

        let size = std::fs::metadata(&path).expect("file exists").len();
        assert!(
            size > 1_024,
            "expected real encoded output, got {size} bytes"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// Encode one frame at each attached display's real size, with the
    /// bitrate and level the domain would actually pick for it.
    ///
    /// [`accepts_an_ultrawide_frame_size`] pins one known-hard size, and
    /// a fixed size is the right shape for a regression test. This one
    /// covers something a fixed size cannot: that the encoder accepts
    /// what *this* machine will ask for. The failure it guards is both
    /// size-specific and driver-specific — an encoder that will not take
    /// a media type for a frame wider than 4096 refuses at negotiation,
    /// and the user sees "no H.264 encoder available" the instant they
    /// press Record, with nothing recorded and nothing to retry.
    ///
    /// Deriving the bitrate and level here rather than stating them is
    /// the point: it tests the two crates' agreement at a size neither
    /// of them has a constant for.
    #[test]
    #[ignore = "needs a Windows session with Media Foundation encoders"]
    fn accepts_every_attached_display_at_its_real_size() {
        use clippity_domain::recorder::{h264_level, video_bitrate_bps};
        use std::time::{SystemTime, UNIX_EPOCH};

        let _com = ComThread::init().expect("COM + Media Foundation start");
        let monitors = xcap::Monitor::all().expect("enumerate monitors");
        assert!(!monitors.is_empty(), "no monitors to test against");

        for (i, monitor) in monitors.iter().enumerate() {
            // H.264 needs even dimensions; an odd-sized mode would be
            // rounded by the recorder before it ever reached the sink.
            let width = monitor.width().expect("monitor width") & !1;
            let height = monitor.height().expect("monitor height") & !1;
            let fps = 60u32;
            let bitrate_bps = video_bitrate_bps(
                clippity_domain::recorder::RecorderQuality::Balanced,
                width,
                height,
                fps,
            );
            let level = h264_level(width, height, fps, bitrate_bps);
            println!("display {i}: {width}x{height} @ {fps} -> {bitrate_bps} bps, level {level}");

            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!("clippity-mf-real-{stamp}.mp4"));

            let mut writer = Mp4Writer::create(
                &path,
                Mp4Config {
                    width,
                    height,
                    source_width: width,
                    source_height: height,
                    fps,
                    bitrate_bps,
                    keyframe_frames: fps * 2,
                    variable_bitrate: true,
                    prefer_hardware: true,
                    level,
                    audio: None,
                },
            )
            .unwrap_or_else(|e| panic!("encoder refused {width}x{height} at level {level}: {e}"));

            // Negotiation is what breaks at these sizes, not the steady
            // state, so one frame is the whole test.
            let bgra = vec![0u8; (width as usize) * (height as usize) * 4];
            writer
                .write_video(&bgra, nv12::PixelOrder::Bgra, 0, 10_000_000 / fps as i64)
                .unwrap_or_else(|e| panic!("{width}x{height} frame rejected: {e}"));
            writer.finish().expect("finalize");

            let size = std::fs::metadata(&path).expect("file exists").len();
            assert!(
                size > 1_024,
                "expected real encoded output, got {size} bytes"
            );
            let _ = std::fs::remove_file(&path);
        }
    }

    // ---------- COM apartments ----------
    //
    // Each of these runs on its own thread, because an apartment is a
    // property of a thread and the test harness's threads are shared.

    #[test]
    fn com_init_succeeds_on_a_thread_that_is_already_an_sta() {
        // The regression. A non-async Tauri command runs on the main
        // thread, which is an STA because the window and WebView need
        // one — so asking for an MTA there returns RPC_E_CHANGED_MODE.
        // Treating that as fatal made opening any recording in Studio
        // fail with "COM init failed: HRESULT(0x80010106)".
        use windows::Win32::System::Com::COINIT_APARTMENTTHREADED;

        std::thread::spawn(|| {
            // SAFETY: a fresh thread, initialised once as an STA — the
            // apartment the app's main thread is already in.
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            assert!(hr.is_ok(), "the STA itself should initialise: {hr:?}");

            let guard = ComThread::init();
            assert!(
                guard.is_ok(),
                "an inherited STA must not stop Media Foundation being used: {:?}",
                guard.err()
            );
            // Dropping must not tear down the STA we did not create.
            drop(guard);

            // Still usable afterwards: a guard that wrongly balanced the
            // changed-mode call would have uninitialised this apartment.
            let again = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            assert!(
                again.is_ok(),
                "the caller's apartment was torn down underneath them: {again:?}"
            );
            unsafe { CoUninitialize() };
            unsafe { CoUninitialize() };
        })
        .join()
        .expect("the STA thread should not panic");
    }

    #[test]
    fn com_init_works_on_a_thread_with_no_apartment_yet() {
        std::thread::spawn(|| {
            let guard = ComThread::init().expect("a bare thread joins the MTA");
            drop(guard);
        })
        .join()
        .expect("the bare thread should not panic");
    }

    #[test]
    fn nested_com_guards_leave_the_apartment_alive_for_the_outer_one() {
        // The `S_FALSE` path. The inner guard's init returns "already
        // initialised, same mode" — a success that still takes a
        // reference, so it must be balanced. Getting this wrong in the
        // other direction leaks the apartment for the thread's life.
        std::thread::spawn(|| {
            let outer = ComThread::init().expect("outer");
            {
                let inner = ComThread::init().expect("inner");
                drop(inner);
            }
            // If the inner drop had over-balanced, COM would be gone
            // here and this call would report a *fresh* initialisation
            // (S_OK) rather than an existing one (S_FALSE).
            // SAFETY: same thread, balanced immediately below.
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            assert_eq!(
                hr.0, 1,
                "expected S_FALSE — the apartment should still be up, got {hr:?}"
            );
            unsafe { CoUninitialize() };
            drop(outer);
        })
        .join()
        .expect("the nested thread should not panic");
    }

    #[test]
    fn audio_constants_agree_with_each_other() {
        // Block align must be channels × bytes-per-sample, or every
        // audio timestamp the encoder derives is wrong.
        assert_eq!(
            AUDIO_BLOCK_ALIGN,
            AUDIO_CHANNELS as u32 * (AUDIO_BITS_PER_SAMPLE / 8)
        );
        // The AAC encoder only accepts 44.1 or 48 kHz.
        assert!(AUDIO_SAMPLE_RATE == 48_000 || AUDIO_SAMPLE_RATE == 44_100);
        // …and 1 or 2 channels.
        assert!(AUDIO_CHANNELS == 1 || AUDIO_CHANNELS == 2);
        // …and only 16-bit input.
        assert_eq!(AUDIO_BITS_PER_SAMPLE, 16);
    }
}
