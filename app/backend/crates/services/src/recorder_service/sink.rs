//! The one-session-two-outputs fork.
//!
//! A [`RecordingSink`] is "somewhere frames go". The session loop knows
//! nothing about H.264 or LZW — it grabs a rectangle on a cadence,
//! stamps a timestamp on it, and hands it here. That is what lets a
//! single capture path serve both the Record and GIF entry points
//! instead of duplicating the pacing, pause clock, and audio mixing per
//! format.
//!
//! Both implementations stream to disk. Neither accumulates frames: see
//! the module docs on `recorder_service` for why buffering is not an
//! option at either format's duration ceiling.

use std::path::Path;

use image::RgbaImage;

use clippity_domain::recorder::{RecorderFormat, ValidatedRecorderRequest};
use clippity_infra::error::AppResult;

use super::{gif_sink, mp4_sink};

/// Where a session's frames and audio are written.
pub trait RecordingSink: Send {
    /// Encode one captured frame. `timestamp_hns` is its position on
    /// the session timeline in 100 ns ticks; `duration_hns` is the
    /// nominal frame duration.
    fn write_frame(
        &mut self,
        frame: &RgbaImage,
        timestamp_hns: i64,
        duration_hns: i64,
    ) -> AppResult<()>;

    /// Encode a run of 16-bit stereo PCM. A no-op for formats without
    /// audio, so the session loop never has to branch on format.
    fn write_audio(&mut self, pcm: &[u8], timestamp_hns: i64, duration_hns: i64)
        -> AppResult<()>;

    /// Whether feeding audio is worth the mixing cost at all. Lets the
    /// mixer skip its work entirely for GIF rather than converting
    /// samples this sink will discard.
    fn wants_audio(&self) -> bool;

    /// Bytes committed so far, for the HUD's size readout.
    fn bytes_written(&self) -> u64;

    /// Flush and close. Consumes the sink — the file's trailer has to
    /// be written before the caller renames it.
    fn finish(self: Box<Self>) -> AppResult<()>;
}

/// Open the sink the request's format calls for.
pub fn open(path: &Path, request: &ValidatedRecorderRequest) -> AppResult<Box<dyn RecordingSink>> {
    match request.format {
        RecorderFormat::Mp4 => mp4_sink::open(path, request),
        RecorderFormat::Gif => gif_sink::open(path, request),
    }
}

/// Size of the file on disk, or 0 while it has none yet.
///
/// Shared by both sinks: asking the filesystem is cheaper and more
/// honest than counting bytes handed to an encoder, which buffers
/// internally and would make the HUD report a size the file doesn't
/// have yet.
pub(super) fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}
