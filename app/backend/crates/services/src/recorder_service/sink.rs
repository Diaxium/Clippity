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

use clippity_domain::media::ValidatedTrim;
use clippity_domain::pixels::{self, PixelOrder};
use clippity_domain::recorder::{self, RecorderFormat, ValidatedRecorderRequest};
use clippity_infra::error::AppResult;

use super::{gif_sink, mp4_sink};

/// One frame on its way to an encoder: borrowed pixels, plus enough to
/// read them.
///
/// **A view rather than an `RgbaImage`,** which is what this used to be,
/// for one reason: an `RgbaImage` can only hold one channel order, so
/// every frame off a Win32 surface had to be swapped into it before the
/// sink would take it. That swap is a whole pass over the frame — at
/// 5120x1440, 28 MiB read and 28 MiB written for a rearrangement the
/// encoder's own colour conversion would have done for free, since it
/// reads red and blue through indices either way.
///
/// So the order travels with the pixels and the sink decides what to do
/// about it. MP4 does nothing (it passes the order through to the NV12
/// conversion). GIF, whose quantizer is built on `image`'s RGBA types,
/// materialises — and pays for a swap only at GIF's already much
/// smaller frame size.
#[derive(Clone, Copy)]
pub struct SinkFrame<'a> {
    /// Tightly packed, `width * height * 4` bytes, top-down.
    pub pixels: &'a [u8],
    pub width: u32,
    pub height: u32,
    pub order: PixelOrder,
}

impl<'a> SinkFrame<'a> {
    /// A frame the caller already holds as an `RgbaImage` — Studio's
    /// trim, whose frames come from a decoder and have annotations
    /// composited onto them.
    pub fn rgba(image: &'a RgbaImage) -> Self {
        Self {
            pixels: image.as_raw(),
            width: image.width(),
            height: image.height(),
            order: PixelOrder::Rgba,
        }
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Whether the pixel buffer matches the geometry it claims.
    ///
    /// Checked by the sinks before they index it: a mismatch here means
    /// a capture and a negotiated size disagreed, and reading past the
    /// end would be the way that surfaces.
    pub fn is_well_formed(&self) -> bool {
        self.pixels.len() == self.width as usize * self.height as usize * 4
    }

    /// Materialise as an `RgbaImage`, swapping channels if needed.
    ///
    /// **The copy is the point of avoiding this** — only call it from a
    /// path that genuinely needs `image`'s types. Alpha is forced opaque
    /// on the way: a Desktop Duplication surface's alpha byte is
    /// whatever the compositor last left there, and a GIF that honoured
    /// it would come out with holes in the picture.
    pub fn to_rgba_image(&self) -> Option<RgbaImage> {
        if !self.is_well_formed() {
            return None;
        }
        let mut pixels = self.pixels.to_vec();
        if self.order != PixelOrder::Rgba {
            pixels::swap_red_blue(&mut pixels);
        }
        for pixel in pixels.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        RgbaImage::from_raw(self.width, self.height, pixels)
    }
}

/// Where a session's frames and audio are written.
pub trait RecordingSink: Send {
    /// Encode one captured frame. `timestamp_hns` is its position on
    /// the session timeline in 100 ns ticks; `duration_hns` is the
    /// nominal frame duration.
    fn write_frame(
        &mut self,
        frame: SinkFrame<'_>,
        timestamp_hns: i64,
        duration_hns: i64,
    ) -> AppResult<()>;

    /// Encode a run of 16-bit stereo PCM. A no-op for formats without
    /// audio, so the session loop never has to branch on format.
    fn write_audio(&mut self, pcm: &[u8], timestamp_hns: i64, duration_hns: i64) -> AppResult<()>;

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

/// Everything a sink needs to describe its output.
///
/// Deliberately smaller than [`ValidatedRecorderRequest`], and that is
/// the point: a live session is not the only thing that produces frames
/// any more. Studio's trim decodes an existing clip and feeds these same
/// encoders, and it has no region, no window id and no capture toggles
/// to offer. Narrowing the sinks to what they actually read is what lets
/// one encoder path serve both — and is why trim-to-GIF required no new
/// encoder at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SinkConfig {
    /// Size of the frames [`RecordingSink::write_frame`] will receive.
    /// **Not** the output size — a sink applies its own format's rules
    /// (GIF scales down internally; see `gif_sink`) and the user's
    /// resolution cap on top. Ask [`Self::output_size`] for what will be
    /// in the file.
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Cap on the encoded frame's height, or
    /// `recorder::RESOLUTION_SOURCE` for "encode what was captured".
    ///
    /// Carried as the *request* rather than as a resolved size because
    /// resolving it needs the format, and the format is what picks the
    /// sink — so a sink that resolves its own is the one place where
    /// both are known.
    pub max_height: u32,
    /// H.264 encoder settings. Read only by `mp4_sink` — GIF has no
    /// bitrate, no keyframes and no rate control, so it ignores this
    /// rather than being handed a narrower config type it would be the
    /// only user of.
    pub encoding: recorder::RecorderEncoding,
    /// Whether to declare an audio stream. A file with no audio must
    /// have **no** stream rather than a silent one — a zero-sample track
    /// makes some players report the file as broken.
    pub with_audio: bool,
}

impl SinkConfig {
    /// What a live recording session asks for.
    pub fn for_recording(request: &ValidatedRecorderRequest) -> Self {
        Self {
            width: request.region.width,
            height: request.region.height,
            fps: request.fps,
            max_height: request.max_height,
            encoding: request.encoding,
            with_audio: request.audio.any(),
        }
    }

    /// What a Studio trim asks for.
    ///
    /// No resolution cap: a trim re-encodes an existing clip, and
    /// shrinking it would be a second, unasked-for edit on top of the
    /// one the user made. Studio owns its own export sizing.
    ///
    /// Default encoding, for the same reason: a trim inherits the source
    /// clip's character, and re-deriving it from whatever the *recording*
    /// preferences happen to say today would make the export depend on a
    /// setting the user changed after the clip was made.
    pub fn for_trim(trim: &ValidatedTrim) -> Self {
        Self {
            width: trim.width,
            height: trim.height,
            fps: trim.fps,
            max_height: recorder::RESOLUTION_SOURCE,
            encoding: recorder::RecorderEncoding::default(),
            with_audio: trim.with_audio,
        }
    }

    /// The dimensions this config's frames will be encoded at, for
    /// `format`.
    pub fn output_size(&self, format: RecorderFormat) -> (u32, u32) {
        recorder::output_size(format, self.width, self.height, self.max_height)
    }
}

/// Open the sink `format` calls for.
pub fn open(
    path: &Path,
    format: RecorderFormat,
    config: SinkConfig,
) -> AppResult<Box<dyn RecordingSink>> {
    match format {
        RecorderFormat::Mp4 => mp4_sink::open(path, config),
        RecorderFormat::Gif => gif_sink::open(path, config),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_over_an_rgba_image_borrows_it_unchanged() {
        let image = RgbaImage::from_raw(2, 1, vec![1, 2, 3, 4, 5, 6, 7, 8]).expect("image");
        let frame = SinkFrame::rgba(&image);
        assert_eq!(frame.dimensions(), (2, 1));
        assert_eq!(frame.order, PixelOrder::Rgba);
        assert!(frame.is_well_formed());
        assert_eq!(frame.pixels, image.as_raw().as_slice());
    }

    #[test]
    fn materialising_a_bgra_frame_puts_red_back_where_image_expects_it() {
        // The failure this guards is a GIF that comes out as its own
        // colour negative, which is what a BGRA capture handed to the
        // quantizer unswapped produces.
        let bgra = [0u8, 0, 255, 255]; // blue, green, red, alpha => red
        let frame = SinkFrame {
            pixels: &bgra,
            width: 1,
            height: 1,
            order: PixelOrder::Bgra,
        };
        let image = frame.to_rgba_image().expect("materialises");
        assert_eq!(image.get_pixel(0, 0).0, [255, 0, 0, 255]);
    }

    #[test]
    fn materialising_an_rgba_frame_leaves_the_channels_alone() {
        let rgba = [255u8, 0, 0, 255];
        let frame = SinkFrame {
            pixels: &rgba,
            width: 1,
            height: 1,
            order: PixelOrder::Rgba,
        };
        let image = frame.to_rgba_image().expect("materialises");
        assert_eq!(image.get_pixel(0, 0).0, [255, 0, 0, 255]);
    }

    #[test]
    fn materialising_forces_alpha_opaque() {
        // A duplication surface's alpha is whatever the compositor left
        // there. Honouring it would punch holes in a GIF.
        let transparent = [10u8, 20, 30, 0];
        let frame = SinkFrame {
            pixels: &transparent,
            width: 1,
            height: 1,
            order: PixelOrder::Bgra,
        };
        let image = frame.to_rgba_image().expect("materialises");
        assert_eq!(image.get_pixel(0, 0).0[3], 255);
    }

    #[test]
    fn a_frame_whose_buffer_disagrees_with_its_geometry_is_refused() {
        let short = [0u8; 7];
        let frame = SinkFrame {
            pixels: &short,
            width: 2,
            height: 1,
            order: PixelOrder::Rgba,
        };
        assert!(!frame.is_well_formed());
        assert!(frame.to_rgba_image().is_none());
    }
}
