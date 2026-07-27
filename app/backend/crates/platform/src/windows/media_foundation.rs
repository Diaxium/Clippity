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

use windows::core::PCWSTR;
use windows::Win32::Media::MediaFoundation::{
    eAVEncH264VProfile_Main, IMFAttributes, IMFMediaType, IMFSinkWriter, MFCreateAttributes,
    MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample, MFCreateSinkWriterFromURL, MFStartup,
    MFTranscodeContainerType_FMPEG4, MFAudioFormat_AAC, MFAudioFormat_PCM, MFMediaType_Audio,
    MFMediaType_Video, MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoInterlace_Progressive,
    MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, MF_MT_AAC_PAYLOAD_TYPE, MF_MT_ALL_SAMPLES_INDEPENDENT,
    MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT,
    MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MPEG2_PROFILE,
    MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
    MF_SINK_WRITER_DISABLE_THROTTLING, MF_TRANSCODE_CONTAINERTYPE, MF_VERSION, MFSTARTUP_FULL,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

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
    /// False when this thread was already initialised by someone else —
    /// in which case balancing the call is *their* job, not ours.
    owned: bool,
}

impl ComThread {
    /// Join the multi-threaded apartment and start Media Foundation.
    ///
    /// MTA rather than STA because nothing here pumps a message loop; an
    /// STA MF caller that never dispatches messages deadlocks the first
    /// time the encoder marshals a call back.
    pub fn init() -> AppResult<Self> {
        // SAFETY: no preconditions; returns S_FALSE (not an error) when
        // the thread is already in a compatible apartment.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr.is_err() {
            return Err(AppError::Recorder(format!(
                "COM init failed: {hr:?} — the recorder cannot reach Media Foundation"
            )));
        }
        // S_FALSE means "already initialised on this thread": we must
        // not un-initialise someone else's apartment on drop.
        let owned = hr.0 == 0;

        ensure_platform()?;
        Ok(Self { owned })
    }
}

impl Drop for ComThread {
    fn drop(&mut self) {
        if self.owned {
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
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_bps: u32,
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
    width: u32,
    height: u32,
    /// Reused NV12 scratch buffer. Allocated once at construction: at
    /// 60 fps a per-frame allocation of several megabytes is a
    /// measurable amount of the frame budget spent in the allocator.
    nv12: Vec<u8>,
    finalized: bool,
}

impl Mp4Writer {
    /// Create the file and negotiate both streams. The file exists (and
    /// is a valid, empty fragmented MP4) as soon as this returns.
    pub fn create(path: &Path, config: Mp4Config) -> AppResult<Self> {
        if config.width == 0 || config.height == 0 {
            return Err(AppError::Recorder("recording has zero area".into()));
        }
        if config.width % 2 != 0 || config.height % 2 != 0 {
            // `domain::recorder::even_dimensions` is supposed to have
            // handled this; failing loudly beats emitting a sheared file.
            return Err(AppError::Recorder(format!(
                "H.264 needs even dimensions, got {}×{}",
                config.width, config.height
            )));
        }

        let attributes = sink_attributes()?;

        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        // SAFETY: `wide` is a NUL-terminated UTF-16 buffer that outlives
        // the call; the byte-stream argument is optional and the
        // attribute store is a valid IMFAttributes.
        let writer = unsafe { MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, &attributes) }
            .map_err(|e| {
                AppError::Recorder(format!("could not open {} for writing: {e}", path.display()))
            })?;

        let video_stream = add_video_stream(&writer, &config)?;
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
            width: config.width,
            height: config.height,
            nv12: vec![0u8; nv12::nv12_len(config.width, config.height)],
            finalized: false,
        })
    }

    /// Whether this writer has an audio stream to feed.
    pub fn has_audio(&self) -> bool {
        self.audio_stream.is_some()
    }

    /// Encode one frame at `timestamp_hns`, lasting `duration_hns`.
    ///
    /// `order` states the source's channel byte order — `xcap` produces
    /// RGBA, raw Win32 surfaces produce BGRA, and guessing swaps red
    /// with blue (see [`nv12::PixelOrder`]).
    ///
    /// Timestamps come from the session's wall clock rather than a frame
    /// counter — see `domain::recorder::hns_from_millis` for why.
    pub fn write_video(
        &mut self,
        pixels: &[u8],
        order: nv12::PixelOrder,
        timestamp_hns: i64,
        duration_hns: i64,
    ) -> AppResult<()> {
        if !nv12::to_nv12(pixels, &mut self.nv12, self.width, self.height, order) {
            return Err(AppError::Recorder(format!(
                "frame does not match the recording geometry ({}×{})",
                self.width, self.height
            )));
        }
        let sample = build_sample(&self.nv12, timestamp_hns, duration_hns)?;
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
        let sample = build_sample(pcm, timestamp_hns, duration_hns)?;
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
fn sink_attributes() -> AppResult<IMFAttributes> {
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
            attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
            // Leave throttling ON (0 = do not disable). Throttling is
            // what makes `WriteSample` block once the encoder falls
            // behind, which is the backpressure the capture worker
            // needs: disabled, a recording the encoder can't keep up
            // with grows a queue in RAM until the process dies, instead
            // of dropping frames.
            attributes.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 0)?;
            // Fragmented MP4 — see the module docs on crash safety.
            attributes.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_FMPEG4)?;
        }
        Ok(())
    })?;
    Ok(attributes)
}

/// Declare the H.264 output type, then the NV12 input type feeding it.
fn add_video_stream(writer: &IMFSinkWriter, config: &Mp4Config) -> AppResult<u32> {
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
            attrs.SetUINT64(&MF_MT_FRAME_SIZE, pack(config.width, config.height))?;
            attrs.SetUINT64(&MF_MT_FRAME_RATE, pack(config.fps, 1))?;
            attrs.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        }
        Ok(())
    })?;
    // SAFETY: a fully-populated output media type.
    let stream = unsafe { writer.AddStream(&out) }
        .map_err(|e| AppError::Recorder(format!("no H.264 encoder available: {e}")))?;

    let input = new_media_type()?;
    configure("NV12 input type", || {
        let attrs: &IMFAttributes = (&input).into();
        // SAFETY: matching uncompressed input type. Geometry and rate
        // must agree with the output type or negotiation fails.
        unsafe {
            attrs.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            attrs.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            attrs.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            // Every uncompressed frame stands alone — lets the encoder
            // skip the "is this a delta frame?" question per sample.
            attrs.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
            attrs.SetUINT64(&MF_MT_FRAME_SIZE, pack(config.width, config.height))?;
            attrs.SetUINT64(&MF_MT_FRAME_RATE, pack(config.fps, 1))?;
            attrs.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        }
        Ok(())
    })?;
    // SAFETY: `stream` was just returned by AddStream on this writer.
    unsafe { writer.SetInputMediaType(stream, &input, None) }
        .map_err(|e| AppError::Recorder(format!("encoder rejected the frame format: {e}")))?;

    Ok(stream)
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
    unsafe { MFCreateMediaType() }
        .map_err(|e| AppError::Recorder(format!("media type: {e}")))
}

/// Copy `payload` into a fresh MF sample stamped with its place on the
/// timeline.
///
/// A new buffer per sample rather than a pooled one: the sink writer
/// keeps a reference for as long as the encoder needs it, so reusing a
/// buffer would overwrite data still queued for encode.
fn build_sample(
    payload: &[u8],
    timestamp_hns: i64,
    duration_hns: i64,
) -> AppResult<windows::Win32::Media::MediaFoundation::IMFSample> {
    let len = payload.len() as u32;
    // SAFETY: a positive length; returns an owned buffer.
    let buffer = unsafe { MFCreateMemoryBuffer(len) }
        .map_err(|e| AppError::Recorder(format!("sample buffer: {e}")))?;

    // SAFETY: Lock hands back a pointer to at least `len` writable
    // bytes (the length just requested); the slice is confined to this
    // block and Unlock is called before the buffer is used again.
    unsafe {
        let mut dst: *mut u8 = std::ptr::null_mut();
        buffer
            .Lock(&mut dst, None, None)
            .map_err(|e| AppError::Recorder(format!("sample buffer lock: {e}")))?;
        std::ptr::copy_nonoverlapping(payload.as_ptr(), dst, payload.len());
        buffer
            .Unlock()
            .map_err(|e| AppError::Recorder(format!("sample buffer unlock: {e}")))?;
        buffer
            .SetCurrentLength(len)
            .map_err(|e| AppError::Recorder(format!("sample length: {e}")))?;
    }

    // SAFETY: a fresh sample; the buffer above is valid and owned.
    let sample = unsafe { MFCreateSample() }
        .map_err(|e| AppError::Recorder(format!("sample: {e}")))?;
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
                fps,
                bitrate_bps: 2_000_000,
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
        assert!(size > 1_024, "expected real encoded output, got {size} bytes");

        // Sanity-check the container: every MP4 starts with a box whose
        // type is `ftyp`, at offset 4.
        let head = std::fs::read(&path).expect("read back");
        assert_eq!(&head[4..8], b"ftyp", "not an MP4 container");

        let _ = std::fs::remove_file(&path);
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
