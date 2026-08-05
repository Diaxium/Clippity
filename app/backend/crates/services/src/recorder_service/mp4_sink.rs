//! MP4 sink — wraps the platform's Media Foundation writer.
//!
//! Thin by design: everything hard about H.264/AAC lives in
//! `clippity_platform::windows::media_foundation`, and this only
//! translates the session's frames into what that writer wants.

use std::path::{Path, PathBuf};

use clippity_domain::recorder;
use clippity_infra::error::{AppError, AppResult};

use super::sink::{file_size, RecordingSink, SinkConfig, SinkFrame};

#[cfg(target_os = "windows")]
pub fn open(path: &Path, config: SinkConfig) -> AppResult<Box<dyn RecordingSink>> {
    use clippity_platform::windows::media_foundation::{AudioTrack, Mp4Config, Mp4Writer};

    // The encoded size, which the resolution cap may have pulled below
    // the captured one. Bitrate and level are derived from *this*, not
    // from the capture: a 1080p file budgeted for 4K would be four times
    // larger than it needs to be, which is the opposite of why anyone
    // caps resolution.
    let (width, height) = config.output_size(recorder::RecorderFormat::Mp4);
    let bitrate_bps = config.encoding.bitrate_bps(width, height, config.fps);
    let writer = Mp4Writer::create(
        path,
        Mp4Config {
            width,
            height,
            source_width: config.width,
            source_height: config.height,
            fps: config.fps,
            bitrate_bps,
            keyframe_frames: config.encoding.keyframe_frames(config.fps),
            variable_bitrate: matches!(
                config.encoding.rate_control,
                recorder::RateControl::Variable
            ),
            prefer_hardware: config.encoding.prefer_hardware,
            // Derived from the frame the encoder is actually being
            // handed, so an ultrawide session states a level big enough
            // to carry it instead of letting the encoder guess low and
            // refuse the media type.
            level: recorder::h264_level(width, height, config.fps, bitrate_bps),
            audio: config.with_audio.then_some(AudioTrack),
        },
    )?;
    let input = writer.input_size();
    Ok(Box::new(Mp4Sink {
        writer,
        path: path.to_path_buf(),
        input,
    }))
}

#[cfg(not(target_os = "windows"))]
pub fn open(_path: &Path, _config: SinkConfig) -> AppResult<Box<dyn RecordingSink>> {
    Err(AppError::Unsupported(
        "encoding video requires Windows Media Foundation",
    ))
}

#[cfg(target_os = "windows")]
struct Mp4Sink {
    writer: clippity_platform::windows::media_foundation::Mp4Writer,
    path: PathBuf,
    /// Frame size the writer negotiated. Normally the captured size —
    /// Media Foundation's video processor does any scaling — so this
    /// matches incoming frames and no resize happens. It differs only on
    /// a machine with no usable processor, where the writer falls back
    /// to taking already-scaled frames and this sink has to produce
    /// them.
    input: (u32, u32),
}

// The writer holds COM interfaces, which `windows-rs` leaves `!Send`.
// The session's worker thread creates this sink and is the only thread
// that ever touches it — it is moved into that thread at construction
// and dropped there — so the marker is sound, and asserting it is what
// lets the sink be a boxed trait object.
#[cfg(target_os = "windows")]
unsafe impl Send for Mp4Sink {}

#[cfg(target_os = "windows")]
impl RecordingSink for Mp4Sink {
    fn write_frame(
        &mut self,
        frame: SinkFrame<'_>,
        timestamp_hns: i64,
        duration_hns: i64,
    ) -> AppResult<()> {
        use clippity_domain::pixels::PixelOrder;

        if !frame.is_well_formed() {
            return Err(AppError::Recorder(format!(
                "a captured frame claimed {}×{} but carried {} bytes",
                frame.width,
                frame.height,
                frame.pixels.len()
            )));
        }

        // The ordinary path: the encoder chain negotiated the captured
        // size, so the frame goes to the NV12 conversion exactly as it
        // came off the capture surface — in whatever channel order that
        // surface produced. Stating the order rather than normalising to
        // one is what keeps red and blue the right way round without a
        // pass over the frame to do it.
        if self.input == frame.dimensions() {
            return self
                .writer
                .write_video(frame.pixels, frame.order, timestamp_hns, duration_hns);
        }

        // The CPU fallback — see `input`. Only reached on a machine with
        // no usable video processor, where the resolution cap has to be
        // applied here instead. `image` needs RGBA, so this is also
        // where a BGRA capture gets swapped; it is the slow path either
        // way.
        let source = frame
            .to_rgba_image()
            .ok_or_else(|| AppError::Recorder("a captured frame had the wrong size".into()))?;
        let scaled = image::imageops::thumbnail(&source, self.input.0, self.input.1);
        self.writer.write_video(
            scaled.as_raw(),
            PixelOrder::Rgba,
            timestamp_hns,
            duration_hns,
        )
    }

    fn write_audio(&mut self, pcm: &[u8], timestamp_hns: i64, duration_hns: i64) -> AppResult<()> {
        self.writer.write_audio(pcm, timestamp_hns, duration_hns)
    }

    fn wants_audio(&self) -> bool {
        self.writer.has_audio()
    }

    fn bytes_written(&self) -> u64 {
        file_size(&self.path)
    }

    fn finish(self: Box<Self>) -> AppResult<()> {
        self.writer.finish()
    }
}
