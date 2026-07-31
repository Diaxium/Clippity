//! GIF sink — the recorder's second output.
//!
//! **Streaming, per-frame palettes.** The textbook way to make a good
//! GIF is to collect every frame, derive one global 256-colour palette
//! from all of them, then quantize against it. That is off the table
//! here: at `GIF_MAX_DURATION_MS` and `GIF_FPS_DEFAULT` the frame set
//! is roughly a gigabyte of RGBA, and holding it would make a long
//! recording a memory-exhaustion bug rather than a big file. Each frame
//! is instead quantized and written as it arrives, with its own local
//! palette — which GIF supports natively, costs a few hundred bytes per
//! frame, and for screen content (flat UI colour, few gradients) is
//! close to indistinguishable from a global one.
//!
//! Audio is accepted and dropped: GIF has no audio track, and
//! `domain::recorder::validate` has already emptied the selection, so
//! this is belt-and-braces rather than a live path.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use image::codecs::gif::{GifEncoder, Repeat};
use image::{Delay, Frame, RgbaImage};

use clippity_domain::recorder::{self, ValidatedRecorderRequest};
use clippity_infra::error::{AppError, AppResult};

use super::sink::{file_size, RecordingSink};

/// Encoder speed, on the `image` crate's 1..=30 scale (higher is
/// faster, lower compresses better).
///
/// 10 rather than the default 1: this runs inside the frame budget of a
/// live recording, and a quantizer tuned for archival quality simply
/// cannot keep up — the session would drop most of its frames and the
/// GIF would stutter. A stuttering GIF is a worse artefact than a
/// slightly larger one.
const ENCODER_SPEED: i32 = 10;

pub fn open(path: &Path, request: &ValidatedRecorderRequest) -> AppResult<Box<dyn RecordingSink>> {
    let file = File::create(path)?;
    let mut encoder = GifEncoder::new_with_speed(BufWriter::new(file), ENCODER_SPEED);
    // A screen-recorded GIF is a loop by convention — a one-shot GIF
    // that freezes on its last frame reads as a broken image.
    encoder
        .set_repeat(Repeat::Infinite)
        .map_err(|e| AppError::Recorder(format!("gif header: {e}")))?;

    let (width, height) = recorder::gif_target_size(request.region.width, request.region.height);
    Ok(Box::new(GifSink {
        encoder: Some(encoder),
        path: path.to_path_buf(),
        delay: recorder::gif_frame_delay_cs(request.fps),
        target: (width, height),
        source: (request.region.width, request.region.height),
    }))
}

struct GifSink {
    /// `None` only after [`RecordingSink::finish`] has taken it — the
    /// trailer is written when the encoder drops.
    encoder: Option<GifEncoder<BufWriter<File>>>,
    path: PathBuf,
    delay: u16,
    target: (u32, u32),
    source: (u32, u32),
}

impl RecordingSink for GifSink {
    fn write_frame(
        &mut self,
        frame: &RgbaImage,
        _timestamp_hns: i64,
        _duration_hns: i64,
    ) -> AppResult<()> {
        let Some(encoder) = self.encoder.as_mut() else {
            return Ok(());
        };

        // Downscale before quantizing, not after: quantizing 4K and
        // then shrinking would spend the whole frame budget on pixels
        // about to be thrown away, and blend palette entries into
        // colours that were never in the palette.
        let scaled = if self.target == self.source {
            frame.clone()
        } else {
            image::imageops::thumbnail(frame, self.target.0, self.target.1)
        };

        // GIF stores delay in centiseconds; `Delay` takes milliseconds
        // as a fraction, so the conversion is ×10 over a denominator
        // of 1.
        let delay = Delay::from_numer_denom_ms(self.delay as u32 * 10, 1);
        encoder
            .encode_frame(Frame::from_parts(scaled, 0, 0, delay))
            .map_err(|e| AppError::Recorder(format!("gif frame: {e}")))
    }

    fn write_audio(
        &mut self,
        _pcm: &[u8],
        _timestamp_hns: i64,
        _duration_hns: i64,
    ) -> AppResult<()> {
        Ok(())
    }

    fn wants_audio(&self) -> bool {
        false
    }

    fn bytes_written(&self) -> u64 {
        file_size(&self.path)
    }

    fn finish(mut self: Box<Self>) -> AppResult<()> {
        // Dropping the encoder writes the GIF trailer and flushes the
        // BufWriter. Taking it explicitly (rather than letting the
        // struct fall out of scope) makes that ordering deliberate and
        // guarantees it happens before the caller renames the file.
        drop(self.encoder.take());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clippity_domain::overlay::Region;
    use clippity_domain::recorder::{RecorderFormat, RecorderTarget, RecorderToggles};

    fn request(width: u32, height: u32, fps: u32) -> ValidatedRecorderRequest {
        ValidatedRecorderRequest {
            target: RecorderTarget::Region,
            region: Region {
                x: 0,
                y: 0,
                width,
                height,
            },
            window_id: None,
            format: RecorderFormat::Gif,
            fps,
            audio: Default::default(),
            toggles: RecorderToggles::default(),
            output_dir: None,
            preset: None,
        }
    }

    fn frame(width: u32, height: u32, shade: u8) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, _| {
            image::Rgba([shade, (x % 256) as u8, 128, 255])
        })
    }

    #[test]
    fn writes_a_real_animated_gif() {
        let dir = std::env::temp_dir().join(format!("clippity-gif-{}", crate::capture_io::next_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.gif");

        let mut sink = open(&path, &request(64, 48, 10)).expect("gif sink opens");
        for i in 0..5u8 {
            sink.write_frame(&frame(64, 48, i * 40), 0, 0)
                .expect("frame encodes");
        }
        sink.finish().expect("trailer written");

        let bytes = std::fs::read(&path).expect("file exists");
        // GIF89a is required for animation (GIF87a has no delays).
        assert_eq!(&bytes[..6], b"GIF89a", "not an animated-capable GIF");
        // Decodes back to the frames we put in.
        let file = std::fs::File::open(&path).unwrap();
        let decoder = image::codecs::gif::GifDecoder::new(std::io::BufReader::new(file)).unwrap();
        let frames = image::AnimationDecoder::into_frames(decoder)
            .collect_frames()
            .expect("decodes");
        assert_eq!(frames.len(), 5, "every frame made it into the file");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_recordings_are_downscaled_in_the_file() {
        let dir =
            std::env::temp_dir().join(format!("clippity-gif-big-{}", crate::capture_io::next_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.gif");

        // 1600×900 is past GIF's pixel budget, so the written frames
        // must be smaller than the captured region.
        let mut sink = open(&path, &request(1_600, 900, 10)).expect("opens");
        sink.write_frame(&frame(1_600, 900, 200), 0, 0).unwrap();
        sink.finish().unwrap();

        let file = std::fs::File::open(&path).unwrap();
        let decoder = image::codecs::gif::GifDecoder::new(std::io::BufReader::new(file)).unwrap();
        let (w, h) = image::ImageDecoder::dimensions(&decoder);
        // Asserted against the rule rather than a literal, so this stays
        // a test of "the sink honours the budget" instead of a second
        // copy of the budget itself.
        assert_eq!(
            (w, h),
            recorder::gif_target_size(1_600, 900),
            "downscaled to the GIF budget"
        );
        assert!(w < 1_600);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_frame_delay_matches_the_requested_rate() {
        let dir =
            std::env::temp_dir().join(format!("clippity-gif-fps-{}", crate::capture_io::next_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fps.gif");

        // 10 fps => 10 cs => 100 ms per frame.
        let mut sink = open(&path, &request(32, 32, 10)).expect("opens");
        sink.write_frame(&frame(32, 32, 10), 0, 0).unwrap();
        sink.write_frame(&frame(32, 32, 90), 0, 0).unwrap();
        sink.finish().unwrap();

        let file = std::fs::File::open(&path).unwrap();
        let decoder = image::codecs::gif::GifDecoder::new(std::io::BufReader::new(file)).unwrap();
        let frames = image::AnimationDecoder::into_frames(decoder)
            .collect_frames()
            .unwrap();
        let (numer, denom) = frames[0].delay().numer_denom_ms();
        assert_eq!(numer / denom, 100, "10 fps must be 100 ms per frame");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn audio_is_accepted_and_ignored() {
        let dir =
            std::env::temp_dir().join(format!("clippity-gif-aud-{}", crate::capture_io::next_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.gif");
        let mut sink = open(&path, &request(32, 32, 10)).unwrap();
        assert!(!sink.wants_audio());
        // Must not error — the session loop is format-agnostic.
        sink.write_audio(&[0u8; 64], 0, 0).unwrap();
        sink.write_frame(&frame(32, 32, 1), 0, 0).unwrap();
        sink.finish().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
