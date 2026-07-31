//! MP4 sink — wraps the platform's Media Foundation writer.
//!
//! Thin by design: everything hard about H.264/AAC lives in
//! `clippity_platform::windows::media_foundation`, and this only
//! translates the session's frames into what that writer wants.

use std::path::{Path, PathBuf};

use image::RgbaImage;

use clippity_domain::recorder::{self, ValidatedRecorderRequest};
#[cfg(not(target_os = "windows"))]
use clippity_infra::error::AppError;
use clippity_infra::error::AppResult;

use super::sink::{file_size, RecordingSink};

#[cfg(target_os = "windows")]
pub fn open(
    path: &Path,
    request: &ValidatedRecorderRequest,
) -> AppResult<Box<dyn RecordingSink>> {
    use clippity_platform::windows::media_foundation::{AudioTrack, Mp4Config, Mp4Writer};

    let (width, height) = (request.region.width, request.region.height);
    let bitrate_bps = recorder::video_bitrate_bps(width, height, request.fps);
    let writer = Mp4Writer::create(
        path,
        Mp4Config {
            width,
            height,
            fps: request.fps,
            bitrate_bps,
            // Derived from the frame the encoder is actually being
            // handed, so an ultrawide session states a level big enough
            // to carry it instead of letting the encoder guess low and
            // refuse the media type.
            level: recorder::h264_level(width, height, request.fps, bitrate_bps),
            // Only declare an audio stream when audio was asked for. A
            // stream that never receives a sample makes some players
            // report the file as broken.
            audio: request.audio.any().then_some(AudioTrack),
        },
    )?;
    Ok(Box::new(Mp4Sink {
        writer,
        path: path.to_path_buf(),
    }))
}

#[cfg(not(target_os = "windows"))]
pub fn open(
    _path: &Path,
    _request: &ValidatedRecorderRequest,
) -> AppResult<Box<dyn RecordingSink>> {
    Err(AppError::Unsupported(
        "screen recording requires Windows Media Foundation",
    ))
}

#[cfg(target_os = "windows")]
struct Mp4Sink {
    writer: clippity_platform::windows::media_foundation::Mp4Writer,
    path: PathBuf,
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
        frame: &RgbaImage,
        timestamp_hns: i64,
        duration_hns: i64,
    ) -> AppResult<()> {
        use clippity_platform::windows::nv12::PixelOrder;
        // `xcap` hands back RGBA; saying so here is what keeps red and
        // blue the right way round in the encoded file.
        self.writer
            .write_video(frame.as_raw(), PixelOrder::Rgba, timestamp_hns, duration_hns)
    }

    fn write_audio(
        &mut self,
        pcm: &[u8],
        timestamp_hns: i64,
        duration_hns: i64,
    ) -> AppResult<()> {
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
