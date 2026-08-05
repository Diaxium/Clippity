//! Media Foundation source reader — the decode half of the recorder's
//! pipeline, used by Studio to describe and re-cut a saved clip.
//!
//! The counterpart to [`super::media_foundation`], and deliberately the
//! same bet: Windows already ships an H.264/AAC **decoder** reachable
//! through `IMFSourceReader`, so reading a recording back costs this
//! file rather than an FFmpeg sidecar in the installer (ADR 0031).
//!
//! **Threading.** As with the writer, every COM interface here is
//! `!Send` and Media Foundation wants an initialised apartment, so a
//! reader is created and used on one thread that holds a
//! [`ComThread`](super::media_foundation::ComThread) guard for its
//! lifetime. Nothing about a reader crosses a thread boundary.
//!
//! **Only what Studio needs.** This is not a general demuxer: it answers
//! "how long, how big, how fast, is there sound" and — for a trim —
//! "give me the frames between these two times". Anything that needs
//! more than that should get its own module rather than growing this
//! one into a media framework.

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::core::{GUID, PCWSTR};
use windows::Win32::Media::MediaFoundation::{
    IMFAttributes, IMFMediaType, IMFSample, IMFSourceReader, MFAudioFormat_PCM, MFCreateAttributes,
    MFCreateMediaType, MFCreateSourceReaderFromURL, MFMediaType_Audio, MFMediaType_Video,
    MFVideoFormat_RGB32, MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_NUM_CHANNELS,
    MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_PD_DURATION, MF_SOURCE_READERF_ENDOFSTREAM,
    MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, MF_SOURCE_READER_FIRST_AUDIO_STREAM,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_SOURCE_READER_MEDIASOURCE,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Variant::{VT_I8, VT_UI8};

use clippity_infra::error::{AppError, AppResult};

use super::media_foundation::ComThread;

/// What [`probe`] can learn about a clip without decoding it.
///
/// Frame rate is kept as the container's own numerator/denominator pair
/// rather than a rounded number, because 30000/1001 ("29.97") is a rate
/// real files use and rounding it at the source would make a long trim's
/// frame grid drift against the audio. Callers that want one number ask
/// [`ProbedMedia::fps`] for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProbedMedia {
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    pub fps_numerator: u32,
    pub fps_denominator: u32,
    pub has_audio: bool,
}

impl ProbedMedia {
    /// Frame rate rounded to the nearest whole number, or `None` when
    /// the container didn't declare one.
    ///
    /// `None` rather than a guess: the caller ([`clippity_domain::media`])
    /// owns what to assume, and baking a default in here would hide
    /// which files actually said.
    pub fn fps(&self) -> Option<u32> {
        if self.fps_numerator == 0 || self.fps_denominator == 0 {
            return None;
        }
        let rate = (self.fps_numerator as f64 / self.fps_denominator as f64).round();
        (rate >= 1.0).then_some(rate as u32)
    }
}

/// Read a media file's shape without decoding any of it.
///
/// Cheap — the source reader parses the container's headers and stops.
/// That is what lets Studio open a two-hour recording as fast as a
/// two-second one, which is the whole reason the duration and frame
/// count come from metadata rather than from counting frames.
pub fn probe(path: &Path) -> AppResult<ProbedMedia> {
    let _com = ComThread::init()?;
    let reader = open_reader(path)?;

    let duration_hns = presentation_duration_hns(&reader)?;
    let video = current_media_type(&reader, MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
        .ok_or_else(|| {
            AppError::Media(format!(
                "{} has no video track this system can read",
                path.display()
            ))
        })?;

    let (width, height) = attribute_pair(&video, &MF_MT_FRAME_SIZE).ok_or_else(|| {
        AppError::Media(format!("{} does not state its frame size", path.display()))
    })?;
    if width == 0 || height == 0 {
        return Err(AppError::Media(format!(
            "{} reports a zero-area frame",
            path.display()
        )));
    }
    // A container is allowed to omit the rate; `fps()` reports that as
    // `None` rather than inventing one here.
    let (fps_numerator, fps_denominator) =
        attribute_pair(&video, &MF_MT_FRAME_RATE).unwrap_or((0, 0));

    let has_audio =
        current_media_type(&reader, MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32).is_some();

    Ok(ProbedMedia {
        width,
        height,
        // 100 ns ticks → ms. Rounds down, so a clip never claims to be
        // longer than it is — a timeline that can seek past the last
        // frame shows a black stall the user reads as a broken file.
        duration_ms: (duration_hns / 10_000).max(0) as u64,
        fps_numerator,
        fps_denominator,
        has_audio,
    })
}

/// A clip open for decoding, positioned somewhere on its timeline.
///
/// Produced by [`Decoder::open`] and driven by pulling samples. Holds
/// COM interfaces, so — like the writer — it is created and used on one
/// thread that owns a [`ComThread`] guard.
pub struct Decoder {
    reader: IMFSourceReader,
    width: u32,
    height: u32,
    /// Bytes per row of the decoded RGB32 buffer, and its sign.
    ///
    /// Not assumed to be `width * 4`, and not assumed to be positive.
    /// An uncompressed RGB surface follows the GDI convention where a
    /// **negative** stride means the rows arrive bottom-up — the exact
    /// trap ADR 0031 avoided on the writing side by feeding NV12. On the
    /// reading side there is no such escape (the caller wants RGBA), so
    /// the orientation is read from the media type and honoured rather
    /// than guessed. Guessing produces a file that is silently upside
    /// down: valid, playable, and wrong.
    stride: i32,
    has_audio: bool,
}

/// One decoded video frame, top-down RGBA.
pub struct VideoFrame {
    pub rgba: Vec<u8>,
    pub timestamp_hns: i64,
}

/// One run of decoded audio: interleaved 16-bit stereo PCM at
/// [`super::media_foundation::AUDIO_SAMPLE_RATE`].
pub struct AudioChunk {
    pub pcm: Vec<u8>,
    pub timestamp_hns: i64,
}

impl Decoder {
    /// Open `path` and negotiate uncompressed output.
    ///
    /// The source reader is asked for RGB32 video and 16-bit PCM audio;
    /// Media Foundation inserts the decoders and converters needed to
    /// get there. That is the whole reason this is cheap to own: the
    /// same platform that encodes the recording decodes it back, so a
    /// trim needs no new codec and nothing added to the installer.
    pub fn open(path: &Path, want_audio: bool) -> AppResult<Self> {
        let reader = open_reader(path)?;

        // Without this the reader will only hand back formats the
        // decoder natively produces (NV12), and refuses the RGB32
        // request rather than inserting a converter.
        let video = uncompressed_type(&MFMediaType_Video, &MFVideoFormat_RGB32)?;
        // SAFETY: a fully-populated uncompressed media type on a valid
        // stream index.
        unsafe {
            reader.SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &video)
        }
        .map_err(|e| AppError::Media(format!("this system cannot decode the video: {e}")))?;

        let has_audio = want_audio && {
            let audio = pcm_output_type()?;
            // SAFETY: as above, on the audio stream.
            unsafe {
                reader.SetCurrentMediaType(
                    MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32,
                    None,
                    &audio,
                )
            }
            .is_ok()
        };

        // Read the geometry back from the *negotiated* type rather than
        // from the probe: the converter is entitled to hand back a
        // different stride, and on some decoders a padded width.
        let negotiated = current_media_type(&reader, MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
            .ok_or_else(|| AppError::Media("the video stream vanished".into()))?;
        let (width, height) = attribute_pair(&negotiated, &MF_MT_FRAME_SIZE)
            .ok_or_else(|| AppError::Media("the decoder did not state a frame size".into()))?;

        let attrs: &IMFAttributes = (&negotiated).into();
        // SAFETY: reading an optional INT32 attribute.
        let stride = unsafe { attrs.GetUINT32(&MF_MT_DEFAULT_STRIDE) }
            .map(|v| v as i32)
            // Absent means the packed, top-down layout.
            .unwrap_or((width * 4) as i32);

        Ok(Self {
            reader,
            width,
            height,
            stride,
            has_audio,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn has_audio(&self) -> bool {
        self.has_audio
    }

    /// Move both streams to `position_hns`.
    ///
    /// Media Foundation seeks to the nearest keyframe **at or before**
    /// the request and decodes forward from there, so the first frames
    /// out may predate the target. That is correct and is why the caller
    /// discards samples before its in-point rather than trusting the
    /// first one it gets — the alternative, seeking exactly, would mean
    /// cutting mid-GOP and producing a clip that starts with a smear.
    pub fn seek(&mut self, position_hns: i64) -> AppResult<()> {
        let mut position = PROPVARIANT::default();
        // SAFETY: writing the union arm matching the tag being set. A
        // seek position is VT_I8 per `IMFSourceReader::SetCurrentPosition`.
        unsafe {
            let inner = &mut position.Anonymous.Anonymous;
            inner.vt = VT_I8;
            inner.Anonymous.hVal = position_hns;
        }
        // SAFETY: the all-zero GUID selects the default (100 ns) time
        // format, which is the unit `position_hns` is already in.
        unsafe { self.reader.SetCurrentPosition(&GUID::zeroed(), &position) }
            .map_err(|e| AppError::Media(format!("could not seek the clip: {e}")))
    }

    /// Next video frame, or `None` at the end of the stream.
    pub fn read_video(&mut self) -> AppResult<Option<VideoFrame>> {
        let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
        let Some((sample, timestamp_hns)) = self.read_sample(stream)? else {
            return Ok(None);
        };
        let packed = copy_sample(&sample)?;
        Ok(Some(VideoFrame {
            rgba: self.to_rgba(&packed)?,
            timestamp_hns,
        }))
    }

    /// Next run of audio, or `None` at the end of the stream (or when
    /// the clip has no audio).
    pub fn read_audio(&mut self) -> AppResult<Option<AudioChunk>> {
        if !self.has_audio {
            return Ok(None);
        }
        let stream = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
        let Some((sample, timestamp_hns)) = self.read_sample(stream)? else {
            return Ok(None);
        };
        Ok(Some(AudioChunk {
            pcm: copy_sample(&sample)?,
            timestamp_hns,
        }))
    }

    /// Pull one sample from `stream`, skipping the format-change and
    /// gap notifications the reader interleaves with real data.
    fn read_sample(&mut self, stream: u32) -> AppResult<Option<(IMFSample, i64)>> {
        loop {
            let mut flags = 0u32;
            let mut timestamp = 0i64;
            let mut sample: Option<IMFSample> = None;
            // SAFETY: out-params are all initialised and live for the
            // call; `sample` is populated with an owned reference or
            // left None.
            unsafe {
                self.reader.ReadSample(
                    stream,
                    0,
                    None,
                    Some(&mut flags),
                    Some(&mut timestamp),
                    Some(&mut sample),
                )
            }
            .map_err(|e| AppError::Media(format!("decode failed: {e}")))?;

            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                return Ok(None);
            }
            match sample {
                // A null sample with no end-of-stream flag is a gap or a
                // format change — ask again rather than treating it as
                // the end of the clip.
                None => continue,
                Some(sample) => return Ok(Some((sample, timestamp))),
            }
        }
    }

    /// Repack a decoded RGB32 buffer into top-down RGBA.
    ///
    /// Two conversions at once, both mandatory and both silent when
    /// wrong: RGB32 is B,G,R,A in memory (so red and blue swap), and a
    /// negative stride means the rows are stored bottom-up.
    fn to_rgba(&self, packed: &[u8]) -> AppResult<Vec<u8>> {
        let width = self.width as usize;
        let height = self.height as usize;
        let row_bytes = width * 4;
        let stride = self.stride.unsigned_abs() as usize;
        let bottom_up = self.stride < 0;

        if stride < row_bytes || packed.len() < stride * height {
            return Err(AppError::Media(format!(
                "decoded frame is {} bytes, too small for {}×{} at stride {}",
                packed.len(),
                width,
                height,
                stride
            )));
        }

        let mut rgba = vec![0u8; row_bytes * height];
        for y in 0..height {
            let source_row = if bottom_up { height - 1 - y } else { y };
            let src = &packed[source_row * stride..source_row * stride + row_bytes];
            let dst = &mut rgba[y * row_bytes..(y + 1) * row_bytes];
            for (out, pixel) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                out[0] = pixel[2]; // R ← the third byte of B,G,R,A
                out[1] = pixel[1];
                out[2] = pixel[0];
                out[3] = 255; // decoded video is opaque; the A byte is padding
            }
        }
        Ok(rgba)
    }
}

/// An uncompressed media type asking for `subtype`.
fn uncompressed_type(
    major: &windows::core::GUID,
    subtype: &windows::core::GUID,
) -> AppResult<IMFMediaType> {
    // SAFETY: allocates an empty media type.
    let media_type = unsafe { MFCreateMediaType() }
        .map_err(|e| AppError::Media(format!("could not describe a media type: {e}")))?;
    let attrs: &IMFAttributes = (&media_type).into();
    // SAFETY: standard major/subtype keys.
    unsafe {
        attrs
            .SetGUID(&MF_MT_MAJOR_TYPE, major)
            .and_then(|_| attrs.SetGUID(&MF_MT_SUBTYPE, subtype))
    }
    .map_err(|e| AppError::Media(format!("could not describe a media type: {e}")))?;
    Ok(media_type)
}

/// The PCM shape the recorder's sinks already speak, so a decoded
/// track can be handed straight to them without a second resampler.
fn pcm_output_type() -> AppResult<IMFMediaType> {
    use super::media_foundation::{AUDIO_BITS_PER_SAMPLE, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE};

    let media_type = uncompressed_type(&MFMediaType_Audio, &MFAudioFormat_PCM)?;
    let attrs: &IMFAttributes = (&media_type).into();
    // SAFETY: standard PCM description keys.
    unsafe {
        attrs
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, AUDIO_CHANNELS as u32)
            .and_then(|_| attrs.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, AUDIO_SAMPLE_RATE))
            .and_then(|_| attrs.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, AUDIO_BITS_PER_SAMPLE))
    }
    .map_err(|e| AppError::Media(format!("could not describe PCM output: {e}")))?;
    Ok(media_type)
}

/// Copy a sample's bytes out of COM-owned memory.
fn copy_sample(sample: &IMFSample) -> AppResult<Vec<u8>> {
    // SAFETY: flattens a possibly-multi-buffer sample into one buffer we
    // own a reference to.
    let buffer = unsafe { sample.ConvertToContiguousBuffer() }
        .map_err(|e| AppError::Media(format!("could not read a decoded sample: {e}")))?;

    let mut data: *mut u8 = std::ptr::null_mut();
    let mut length = 0u32;
    // SAFETY: Lock hands back a pointer valid until the matching Unlock,
    // together with the run's length. The copy below stays inside it and
    // Unlock is called on every path out.
    unsafe {
        buffer
            .Lock(&mut data, None, Some(&mut length))
            .map_err(|e| AppError::Media(format!("could not lock a decoded sample: {e}")))?;
        let copied = std::slice::from_raw_parts(data, length as usize).to_vec();
        let _ = buffer.Unlock();
        Ok(copied)
    }
}

/// Open a source reader over a file path.
///
/// Video processing is enabled, which is what lets the reader satisfy a
/// request for RGB32 (and any rescaling) by inserting a converter rather
/// than refusing a format the decoder does not natively emit.
fn open_reader(path: &Path) -> AppResult<IMFSourceReader> {
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);

    // SAFETY: allocates an attribute store with room for one entry.
    let attributes = unsafe {
        let mut store: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut store, 1)
            .map_err(|e| AppError::Media(format!("could not configure the reader: {e}")))?;
        store.ok_or_else(|| AppError::Media("the reader refused configuration".into()))?
    };
    // SAFETY: a documented BOOL-as-UINT32 reader attribute.
    unsafe { attributes.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1) }
        .map_err(|e| AppError::Media(format!("could not configure the reader: {e}")))?;

    // SAFETY: `wide` is a NUL-terminated UTF-16 buffer that outlives the
    // call, and `attributes` is a valid store.
    unsafe { MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), &attributes) }.map_err(|e| {
        AppError::Media(format!(
            "could not open {} for reading: {e}",
            path.display()
        ))
    })
}

/// The presentation's total duration in 100 ns ticks.
fn presentation_duration_hns(reader: &IMFSourceReader) -> AppResult<i64> {
    // SAFETY: MEDIASOURCE is the documented pseudo-stream for
    // presentation-level attributes; the returned PROPVARIANT is owned
    // by the caller and freed when the wrapper drops.
    let value = unsafe {
        reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
    }
    .map_err(|e| AppError::Media(format!("the file does not report a duration: {e}")))?;

    // SAFETY: reading the union arm the variant's own tag says is live.
    // A source that answered MF_PD_DURATION with anything but VT_UI8
    // would be malformed, and is treated as "no duration" rather than
    // reinterpreted.
    let raw = unsafe {
        let inner = &value.Anonymous.Anonymous;
        if inner.vt != VT_UI8 {
            return Err(AppError::Media(
                "the file's duration is not a number this reader understands".into(),
            ));
        }
        inner.Anonymous.uhVal
    };
    Ok(raw.min(i64::MAX as u64) as i64)
}

/// The current media type of a stream, or `None` when the file has no
/// such stream.
///
/// A missing audio track is the ordinary case (GIF-sourced clips, and
/// every recording made with both audio inputs off), so it is an
/// `Option` rather than an error the caller has to pattern-match a
/// specific HRESULT out of.
fn current_media_type(reader: &IMFSourceReader, stream: u32) -> Option<IMFMediaType> {
    // SAFETY: any u32 is a valid stream index to ask about; an absent
    // stream returns an error rather than misbehaving.
    unsafe { reader.GetCurrentMediaType(stream) }.ok()
}

/// Read one of Media Foundation's packed `(high, low)` `UINT64`
/// attributes — the encoding it uses for frame size and frame rate.
///
/// The inverse of the writer's `pack`. Kept here rather than shared
/// because the two modules are on opposite sides of the pipeline and a
/// single helper would have to be public from one to the other for no
/// benefit beyond four lines.
fn attribute_pair(media_type: &IMFMediaType, key: &windows::core::GUID) -> Option<(u32, u32)> {
    let attrs: &IMFAttributes = media_type.into();
    // SAFETY: reading a UINT64 attribute; a missing or differently-typed
    // key returns an error rather than a garbage value.
    let packed = unsafe { attrs.GetUINT64(key) }.ok()?;
    Some(((packed >> 32) as u32, (packed & 0xFFFF_FFFF) as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Report how a real clip is actually laid out on its timeline.
    ///
    /// Not an assertion — a tool. It answers the question no unit test
    /// can, because it needs a file that came off this machine: *are the
    /// frames where the container says they are?*
    ///
    /// It exists because they once were not. A recording whose grabs
    /// could not keep up carried samples that each claimed the nominal
    /// `1/fps` while the next began hundreds of milliseconds later, so
    /// the timeline was mostly holes. Studio looked broken — the
    /// playhead would not approach the start, and playback stopped well
    /// short of the stated end — and every frontend measurement agreed
    /// with the file rather than with reality. This is what found it:
    ///
    /// ```text
    /// CLIPPITY_PROBE_FILE="…\Screen Recording.mp4" \
    ///   cargo test -p clippity-platform report_first_timestamps -- --ignored --nocapture
    /// ```
    ///
    /// A healthy clip reports a mean gap near `1000 / fps`, a worst gap
    /// close to it, and a last timestamp near the declared duration.
    #[test]
    #[ignore = "needs a real clip named by CLIPPITY_PROBE_FILE"]
    fn report_first_timestamps_of_a_real_recording() {
        let Ok(path) = std::env::var("CLIPPITY_PROBE_FILE") else {
            println!("set CLIPPITY_PROBE_FILE to a clip path");
            return;
        };
        let path = std::path::Path::new(&path);
        let info = probe(path).expect("probes");
        println!(
            "probe says: {}x{}  duration {} ms  fps {:?}  audio {}",
            info.width,
            info.height,
            info.duration_ms,
            info.fps(),
            info.has_audio
        );

        let mut decoder = Decoder::open(path, false).expect("opens");
        let mut stamps = Vec::new();
        while let Some(frame) = decoder.read_video().expect("reads") {
            stamps.push(frame.timestamp_hns / 10_000);
        }
        println!("total frames decoded: {}", stamps.len());
        println!(
            "first 12 timestamps (ms): {:?}",
            &stamps[..stamps.len().min(12)]
        );

        let mut sorted = stamps.clone();
        sorted.sort_unstable();
        println!("monotonic as delivered: {}", sorted == stamps);

        let gaps: Vec<i64> = sorted.windows(2).map(|w| w[1] - w[0]).collect();
        let biggest = gaps.iter().copied().max().unwrap_or(0);
        let mean = if gaps.is_empty() {
            0
        } else {
            gaps.iter().sum::<i64>() / gaps.len() as i64
        };
        println!(
            "gap between frames: mean {mean} ms, worst {biggest} ms  \
             -> effective {:.1} fps against a requested 30",
            if mean > 0 { 1000.0 / mean as f64 } else { 0.0 }
        );
        println!(
            "last timestamp {} ms vs declared duration {} ms",
            sorted.last().unwrap_or(&0),
            info.duration_ms
        );
    }

    fn probed(fps_numerator: u32, fps_denominator: u32) -> ProbedMedia {
        ProbedMedia {
            width: 1920,
            height: 1080,
            duration_ms: 1_000,
            fps_numerator,
            fps_denominator,
            has_audio: false,
        }
    }

    #[test]
    fn a_whole_frame_rate_reads_back_whole() {
        assert_eq!(probed(60, 1).fps(), Some(60));
    }

    #[test]
    fn a_broadcast_frame_rate_rounds_to_the_nearest_whole() {
        // 30000/1001 is "29.97" — a rate real files carry.
        assert_eq!(probed(30_000, 1_001).fps(), Some(30));
        assert_eq!(probed(60_000, 1_001).fps(), Some(60));
    }

    #[test]
    fn an_undeclared_frame_rate_is_none_rather_than_a_guess() {
        // The domain layer owns the fallback — see `ProbedMedia::fps`.
        assert_eq!(probed(0, 0).fps(), None);
        assert_eq!(probed(30, 0).fps(), None);
        assert_eq!(probed(0, 1).fps(), None);
    }

    #[test]
    fn a_sub_one_frame_rate_never_rounds_down_to_zero() {
        // A rate below one frame per second is a timelapse, not a
        // recording, but it must still not produce a zero — every
        // frame-step calculation downstream divides by this.
        assert_eq!(probed(1, 2).fps(), Some(1), "half a frame per second");
        // Below the point where rounding would reach zero, the honest
        // answer is "no usable rate" rather than a zero divisor.
        assert_eq!(probed(1, 3).fps(), None, "a third of a frame per second");
    }

    // ---------- live-hardware tests ----------
    //
    // Ignored by default, like the recorder's: these need a real Media
    // Foundation platform and a real file, and they are the ones that
    // compile perfectly and fail at runtime. Run after touching any
    // unsafe or media-type code here:
    //   cargo test -p clippity-platform -- --ignored

    /// Encode a clip with the recorder's own writer, then read it back.
    ///
    /// The most valuable test in this file, and the one that could not be
    /// written before: it closes the loop between the two halves of the
    /// pipeline. A geometry or rate mismatch between what the sink writes
    /// and what the source reader reports is invisible to either side's
    /// own tests, and presents to the user as a Studio timeline whose
    /// length disagrees with the clip playing above it.
    ///
    /// Set `CLIPPITY_KEEP_CLIP` to leave the file on disk (its path is
    /// printed) when one is needed for manual or visual checks.
    #[test]
    #[ignore = "needs a real Media Foundation platform + H.264 encoder"]
    fn a_clip_this_app_wrote_reads_back_with_the_shape_it_was_written_with() {
        use super::super::media_foundation::{Mp4Config, Mp4Writer};
        use super::super::nv12::PixelOrder;

        const WIDTH: u32 = 640;
        const HEIGHT: u32 = 360;
        const FPS: u32 = 30;
        const FRAMES: u32 = 90; // three seconds
        const HNS_PER_FRAME: i64 = 10_000_000 / FPS as i64;

        let _com = ComThread::init().expect("Media Foundation should start");
        let path = std::env::temp_dir().join("clippity-roundtrip.mp4");
        let _ = std::fs::remove_file(&path);

        let mut writer = Mp4Writer::create(
            &path,
            Mp4Config {
                width: WIDTH,
                height: HEIGHT,
                source_width: WIDTH,
                source_height: HEIGHT,
                fps: FPS,
                bitrate_bps: 2_000_000,
                keyframe_frames: FPS * 2,
                variable_bitrate: true,
                prefer_hardware: true,
                level: 31,
                audio: None,
            },
        )
        .expect("the platform should have an H.264 encoder");

        // A moving gradient: something that actually changes between
        // frames, so the encoder produces more than one keyframe and the
        // duration is a real duration rather than a still held open.
        let mut frame = vec![0u8; (WIDTH * HEIGHT * 4) as usize];
        for index in 0..FRAMES {
            for y in 0..HEIGHT {
                for x in 0..WIDTH {
                    let offset = ((y * WIDTH + x) * 4) as usize;
                    frame[offset] = ((x + index * 3) % 256) as u8;
                    frame[offset + 1] = ((y + index * 2) % 256) as u8;
                    frame[offset + 2] = ((index * 5) % 256) as u8;
                    frame[offset + 3] = 255;
                }
            }
            writer
                .write_video(
                    &frame,
                    PixelOrder::Rgba,
                    index as i64 * HNS_PER_FRAME,
                    HNS_PER_FRAME,
                )
                .unwrap_or_else(|e| panic!("frame {index}: {e:?}"));
        }
        writer.finish().expect("the muxer should close the file");

        let info = probe(&path).expect("our own clip should probe");
        assert_eq!((info.width, info.height), (WIDTH, HEIGHT));
        assert_eq!(info.fps(), Some(FPS));
        assert!(!info.has_audio, "no audio stream was declared");
        // Encoders round the last frame's duration, so the length is
        // checked as a neighbourhood rather than an exact figure.
        let expected_ms = (FRAMES * 1_000 / FPS) as i64;
        let drift = (info.duration_ms as i64 - expected_ms).abs();
        assert!(
            drift <= 100,
            "expected ~{expected_ms} ms, got {} ms",
            info.duration_ms
        );

        if std::env::var("CLIPPITY_KEEP_CLIP").is_ok() {
            println!("kept: {}", path.display());
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }

    #[test]
    #[ignore = "needs a real Media Foundation platform"]
    fn a_file_that_is_not_media_fails_rather_than_returning_zeroes() {
        let path = std::env::temp_dir().join("clippity-not-media.mp4");
        std::fs::write(&path, b"this is not an mp4").unwrap();
        let result = probe(&path);
        let _ = std::fs::remove_file(&path);
        assert!(result.is_err(), "got {result:?}");
    }
}
