//! PCM normalisation for the recorder's audio path — pure, no COM.
//!
//! WASAPI hands back whatever the endpoint's mix format happens to be:
//! 32-bit float or 16/24/32-bit integer, mono to 7.1, at 44.1 or 48 kHz
//! (or, for a pro interface, 96). The AAC encoder accepts exactly one
//! shape: 48 kHz, stereo, 16-bit. Everything between those two facts
//! lives here.
//!
//! Split out of `audio.rs` for the same reason `nv12` is split out of
//! `media_foundation`: the conversion is where the subtle bugs are —
//! a channel swap, an off-by-one in the resampler that accumulates into
//! audible drift over a ten-minute recording, a mix that clips — and
//! none of it needs a sound card to test.
//!
//! Internally everything is `f32` in the range -1.0..=1.0. Converting
//! to float once at the input and back to `i16` once at the output
//! means the mixer never has to reason about differing integer depths,
//! and intermediate sums can exceed full scale without wrapping — an
//! `i16` mix of a loud mic over loud system audio wraps to a click.

/// Sample layouts WASAPI mix formats actually use.
///
/// Shared-mode mix formats are float in practice on every modern
/// Windows build, but a pinned device can still negotiate integer, and
/// silently misreading one as the other yields loud noise rather than a
/// polite failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleFormat {
    F32,
    I16,
    I32,
    /// 24-bit packed in 3 bytes — rare, but some USB interfaces use it.
    I24,
}

impl SampleFormat {
    /// Bytes one sample of this format occupies.
    pub fn bytes(self) -> usize {
        match self {
            SampleFormat::F32 | SampleFormat::I32 => 4,
            SampleFormat::I24 => 3,
            SampleFormat::I16 => 2,
        }
    }
}

/// Decode interleaved raw endpoint bytes into interleaved **stereo**
/// f32 frames.
///
/// Channel handling, in the order it matters for a screen recording:
/// - mono is duplicated to both sides, not left-only;
/// - stereo passes through;
/// - anything wider is downmixed by taking the front-left/front-right
///   pair, which in every WAVE channel order is the first two. Summing
///   all channels instead would fold a 5.1 game's centre and LFE into
///   both sides and blow out the level.
///
/// Returns an empty vec on a ragged buffer rather than panicking — a
/// short read from the endpoint is a runtime condition, not a bug.
pub fn decode_to_stereo(raw: &[u8], format: SampleFormat, channels: u16) -> Vec<f32> {
    let channels = channels.max(1) as usize;
    let stride = format.bytes() * channels;
    if stride == 0 || raw.len() < stride {
        return Vec::new();
    }
    let frames = raw.len() / stride;
    let mut out = Vec::with_capacity(frames * 2);

    for f in 0..frames {
        let base = f * stride;
        let left = sample_at(raw, base, format);
        let right = if channels == 1 {
            left
        } else {
            sample_at(raw, base + format.bytes(), format)
        };
        out.push(left);
        out.push(right);
    }
    out
}

/// Read one sample and normalise it to -1.0..=1.0.
fn sample_at(raw: &[u8], offset: usize, format: SampleFormat) -> f32 {
    match format {
        SampleFormat::F32 => {
            let b = [raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]];
            f32::from_le_bytes(b)
        }
        SampleFormat::I16 => {
            let v = i16::from_le_bytes([raw[offset], raw[offset + 1]]);
            v as f32 / 32_768.0
        }
        SampleFormat::I32 => {
            let v = i32::from_le_bytes([
                raw[offset],
                raw[offset + 1],
                raw[offset + 2],
                raw[offset + 3],
            ]);
            v as f32 / 2_147_483_648.0
        }
        SampleFormat::I24 => {
            // Sign-extend the 24-bit little-endian value into an i32 by
            // parking it in the high three bytes and shifting back down.
            let v = i32::from_le_bytes([0, raw[offset], raw[offset + 1], raw[offset + 2]]) >> 8;
            v as f32 / 8_388_608.0
        }
    }
}

/// Streaming linear resampler for interleaved stereo f32.
///
/// **Stateful on purpose.** A resampler that restarts at phase zero for
/// every WASAPI packet re-samples the same instant twice at each packet
/// boundary, which over a long recording accumulates into audible drift
/// against the video — precisely the A/V sync failure the roadmap sets a
/// 100 ms budget for. Carrying the fractional read position and the last
/// frame across calls makes the stream continuous.
///
/// Linear interpolation rather than a windowed-sinc: the input is
/// speech and UI sound resampled by a small ratio (usually 44.1→48),
/// where the difference is inaudible and the cost is a fraction of a
/// frame budget.
pub struct StereoResampler {
    ratio: f64,
    /// Fractional position within the *input* stream, relative to the
    /// last frame carried over from the previous call.
    position: f64,
    /// Final input frame of the previous call, so interpolation across
    /// the packet seam has a left-hand sample to work from.
    last: [f32; 2],
    primed: bool,
}

impl StereoResampler {
    /// A resampler from `from_rate` to `to_rate`. Equal rates still
    /// produce a working (pass-through) resampler.
    pub fn new(from_rate: u32, to_rate: u32) -> Self {
        let from = from_rate.max(1) as f64;
        let to = to_rate.max(1) as f64;
        Self {
            ratio: from / to,
            position: 0.0,
            last: [0.0, 0.0],
            primed: false,
        }
    }

    /// Whether this resampler is a no-op, so the caller can skip the
    /// work entirely on the common 48 kHz-native endpoint.
    pub fn is_passthrough(&self) -> bool {
        (self.ratio - 1.0).abs() < f64::EPSILON
    }

    /// Resample one packet of interleaved stereo frames.
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if input.len() < 2 {
            return Vec::new();
        }
        if self.is_passthrough() {
            return input.to_vec();
        }
        let frames = input.len() / 2;
        let mut out = Vec::with_capacity(((frames as f64 / self.ratio) as usize + 2) * 2);

        // The first call has no carried frame; start on the packet's own
        // first sample instead of interpolating against silence, which
        // would put a click at the head of every recording.
        if !self.primed {
            self.last = [input[0], input[1]];
            self.primed = true;
        }

        let mut pos = self.position;
        while pos < frames as f64 {
            let index = pos.floor() as isize;
            let frac = (pos - pos.floor()) as f32;

            // index == -1 addresses the frame carried from last call.
            let (l0, r0) = if index < 0 {
                (self.last[0], self.last[1])
            } else {
                let i = index as usize * 2;
                (input[i], input[i + 1])
            };
            let next = index + 1;
            let (l1, r1) = if next >= frames as isize {
                // Ran off the end of this packet — hold the last sample
                // rather than reaching into the next one, which hasn't
                // arrived. The carried position picks it up next call.
                (l0, r0)
            } else {
                let i = next as usize * 2;
                (input[i], input[i + 1])
            };

            out.push(l0 + (l1 - l0) * frac);
            out.push(r0 + (r1 - r0) * frac);
            pos += self.ratio;
        }

        self.last = [input[(frames - 1) * 2], input[(frames - 1) * 2 + 1]];
        // Rebase the position into the next packet's coordinate space,
        // keeping the fractional remainder that makes the stream
        // continuous.
        self.position = pos - frames as f64;
        out
    }
}

/// Sum `addition` into `base`, extending `base` when the addition is
/// longer.
///
/// Plain summation, no attenuation: halving both sources to "avoid
/// clipping" makes a mic-only recording quiet for no reason. Levels are
/// the user's to manage; the clamp at
/// [`to_i16_bytes`] is the safety net.
pub fn mix_into(base: &mut Vec<f32>, addition: &[f32]) {
    if base.len() < addition.len() {
        base.resize(addition.len(), 0.0);
    }
    for (b, a) in base.iter_mut().zip(addition) {
        *b += *a;
    }
}

/// Convert interleaved f32 to the little-endian 16-bit PCM bytes the
/// AAC encoder consumes, clamping to full scale.
///
/// The clamp is what stops a mix hotter than full scale from wrapping:
/// an out-of-range float cast to `i16` wraps a loud peak to the
/// *opposite* extreme, which is heard as a hard click rather than the
/// distortion clipping produces.
pub fn to_i16_bytes(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        // 32767 rather than 32768 so +1.0 maps to i16::MAX instead of
        // overflowing to i16::MIN.
        let v = (clamped * 32_767.0).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// Interleaved stereo f32 samples representing `duration_ms` of silence
/// at `sample_rate` — used to hold the audio timeline open across a
/// stretch no endpoint produced data for (nothing playing, or a paused
/// session). Without it, the muxer's audio clock falls behind the
/// video's and the tracks drift apart.
pub fn silence(sample_rate: u32, duration_ms: u64) -> Vec<f32> {
    let frames = (sample_rate as u64 * duration_ms / 1_000) as usize;
    vec![0.0; frames * 2]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_widths_are_what_the_endpoint_declares() {
        assert_eq!(SampleFormat::F32.bytes(), 4);
        assert_eq!(SampleFormat::I32.bytes(), 4);
        assert_eq!(SampleFormat::I24.bytes(), 3);
        assert_eq!(SampleFormat::I16.bytes(), 2);
    }

    #[test]
    fn float_stereo_passes_through_unchanged() {
        let mut raw = Vec::new();
        for v in [0.5f32, -0.25, 1.0, -1.0] {
            raw.extend_from_slice(&v.to_le_bytes());
        }
        let out = decode_to_stereo(&raw, SampleFormat::F32, 2);
        assert_eq!(out, vec![0.5, -0.25, 1.0, -1.0]);
    }

    #[test]
    fn mono_is_duplicated_to_both_sides() {
        // A mono mic must be centred, not hard-left — the single most
        // noticeable audio bug a viewer would hit.
        let mut raw = Vec::new();
        for v in [0.5f32, -0.5] {
            raw.extend_from_slice(&v.to_le_bytes());
        }
        let out = decode_to_stereo(&raw, SampleFormat::F32, 1);
        assert_eq!(out, vec![0.5, 0.5, -0.5, -0.5]);
    }

    #[test]
    fn surround_takes_the_front_pair_rather_than_summing() {
        // 5.1 frame: FL, FR, C, LFE, BL, BR. Summing would fold the
        // centre channel into both sides and overdrive the level.
        let mut raw = Vec::new();
        for v in [0.1f32, 0.2, 0.9, 0.9, 0.9, 0.9] {
            raw.extend_from_slice(&v.to_le_bytes());
        }
        let out = decode_to_stereo(&raw, SampleFormat::F32, 6);
        assert_eq!(out.len(), 2);
        assert!((out[0] - 0.1).abs() < 1e-6);
        assert!((out[1] - 0.2).abs() < 1e-6);
    }

    #[test]
    fn integer_formats_normalise_to_full_scale() {
        let raw16: Vec<u8> = [i16::MAX, i16::MIN]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let out = decode_to_stereo(&raw16, SampleFormat::I16, 2);
        assert!((out[0] - 1.0).abs() < 1e-3, "got {}", out[0]);
        assert!((out[1] + 1.0).abs() < 1e-3, "got {}", out[1]);

        let raw32: Vec<u8> = [i32::MAX, 0].iter().flat_map(|v| v.to_le_bytes()).collect();
        let out = decode_to_stereo(&raw32, SampleFormat::I32, 2);
        assert!((out[0] - 1.0).abs() < 1e-6);
        assert_eq!(out[1], 0.0);
    }

    #[test]
    fn twenty_four_bit_sign_extends() {
        // -1 in 24-bit two's complement is 0xFFFFFF; read without sign
        // extension it would decode as +1.0 instead of a hair under 0.
        let raw: Vec<u8> = vec![0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x40];
        let out = decode_to_stereo(&raw, SampleFormat::I24, 2);
        assert!(out[0] < 0.0 && out[0] > -0.001, "got {}", out[0]);
        assert!((out[1] - 0.5).abs() < 1e-3, "got {}", out[1]);
    }

    #[test]
    fn a_ragged_buffer_yields_nothing_rather_than_panicking() {
        assert!(decode_to_stereo(&[0u8; 3], SampleFormat::F32, 2).is_empty());
        assert!(decode_to_stereo(&[], SampleFormat::F32, 2).is_empty());
    }

    // ---------- resampling ----------

    #[test]
    fn equal_rates_are_a_passthrough() {
        let mut r = StereoResampler::new(48_000, 48_000);
        assert!(r.is_passthrough());
        let input = vec![0.1, 0.2, 0.3, 0.4];
        assert_eq!(r.process(&input), input);
    }

    #[test]
    fn upsampling_produces_proportionally_more_frames() {
        let mut r = StereoResampler::new(44_100, 48_000);
        // 441 input frames ≈ 480 output frames.
        let input: Vec<f32> = (0..441 * 2).map(|i| (i % 100) as f32 / 100.0).collect();
        let out = r.process(&input);
        let frames = out.len() / 2;
        assert!(
            (frames as i32 - 480).abs() <= 2,
            "expected ~480 frames, got {frames}"
        );
    }

    #[test]
    fn a_continuous_stream_does_not_drift_across_packets() {
        // The bug this guards: restarting phase per packet re-samples
        // the seam and slowly gains frames, which is A/V drift. Ten
        // packets in must be within a frame or two of ten packets'
        // worth out.
        let mut r = StereoResampler::new(44_100, 48_000);
        let packet: Vec<f32> = (0..441 * 2).map(|i| (i % 50) as f32 / 50.0).collect();
        let mut total = 0usize;
        for _ in 0..10 {
            total += r.process(&packet).len() / 2;
        }
        assert!(
            (total as i32 - 4_800).abs() <= 3,
            "10 packets should yield ~4800 frames, got {total}"
        );
    }

    #[test]
    fn downsampling_produces_proportionally_fewer_frames() {
        let mut r = StereoResampler::new(96_000, 48_000);
        let input: Vec<f32> = vec![0.5; 960 * 2];
        let frames = r.process(&input).len() / 2;
        assert!(
            (frames as i32 - 480).abs() <= 2,
            "expected ~480 frames, got {frames}"
        );
    }

    #[test]
    fn resampling_a_constant_signal_keeps_it_constant() {
        // Interpolation between equal neighbours must not ring.
        let mut r = StereoResampler::new(44_100, 48_000);
        let input = vec![0.25f32; 441 * 2];
        for v in r.process(&input) {
            assert!((v - 0.25).abs() < 1e-5, "got {v}");
        }
    }

    // ---------- mixing + output ----------

    #[test]
    fn mixing_sums_without_attenuating_either_source() {
        let mut base = vec![0.25, 0.25];
        mix_into(&mut base, &[0.5, -0.5]);
        assert_eq!(base, vec![0.75, -0.25]);
    }

    #[test]
    fn mixing_extends_to_the_longer_source() {
        // System audio delivered a longer packet than the mic; the tail
        // must survive rather than be truncated to the mic's length.
        let mut base = vec![0.1, 0.1];
        mix_into(&mut base, &[0.2, 0.2, 0.3, 0.3]);
        assert_eq!(base.len(), 4);
        assert!((base[2] - 0.3).abs() < 1e-6);
    }

    #[test]
    fn output_clamps_instead_of_wrapping() {
        // 1.5 cast straight to i16 wraps to a large negative — an
        // audible click exactly at the loudest moment.
        let bytes = to_i16_bytes(&[1.5, -1.5]);
        let a = i16::from_le_bytes([bytes[0], bytes[1]]);
        let b = i16::from_le_bytes([bytes[2], bytes[3]]);
        assert_eq!(a, 32_767);
        assert_eq!(b, -32_767);
    }

    #[test]
    fn output_is_little_endian_sixteen_bit() {
        let bytes = to_i16_bytes(&[0.0, 1.0]);
        assert_eq!(bytes.len(), 4);
        assert_eq!(i16::from_le_bytes([bytes[0], bytes[1]]), 0);
        assert_eq!(i16::from_le_bytes([bytes[2], bytes[3]]), 32_767);
    }

    #[test]
    fn silence_is_sized_by_duration_and_rate() {
        // 100 ms at 48 kHz stereo = 4800 frames = 9600 samples.
        assert_eq!(silence(48_000, 100).len(), 9_600);
        assert!(silence(48_000, 0).is_empty());
        assert!(silence(48_000, 100).iter().all(|&s| s == 0.0));
    }
}
