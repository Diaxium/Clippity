//! HDR → SDR tone mapping. Pure math over pixel buffers; the capture
//! that produces the HDR pixels lives in `platform::windows::hdr_capture`.
//!
//! # Why a capture needs this at all
//!
//! On an HDR display the desktop is composed in scRGB: linear,
//! half-float, and *unbounded* — `1.0` is not "white", it is the
//! reference SDR white point of 80 nits, and a specular highlight in a
//! game or a video legitimately sits at 8.0. Asking the compositor for
//! an 8-bit buffer instead makes it hand back that scene squeezed into
//! `[0, 1]` by a conversion designed to be fast rather than faithful,
//! which is why a screenshot taken on an HDR desktop comes out grey,
//! flat and washed out. `enhance.rs` already names this as something it
//! tries to rescue after the fact; this module removes the need to
//! rescue it, by converting from the float source properly.
//!
//! # The conversion, in order
//!
//! 1. **Normalise to SDR white.** Windows reports the display's SDR
//!    white level in nits — usually 200 on an HDR desktop, not the 80
//!    of the scRGB reference — so dividing by it puts ordinary desktop
//!    white at exactly `1.0`. This step is the fix. Skipping it is
//!    precisely what makes an HDR screenshot look wrong.
//! 2. **Clamp to the SDR range.** See the trade-off below.
//! 3. **Encode to sRGB.** The buffer is linear; PNG is not.
//!
//! # The trade-off: SDR is exact, highlights clip
//!
//! Content brighter than SDR white is clamped rather than compressed
//! into the top of the range, and that is a deliberate choice rather
//! than a shortcut.
//!
//! A soft highlight roll-off and an exact SDR range are mutually
//! exclusive in 8 bits, and not by a little. Roll-off has to start
//! below white to have anywhere to compress *into*, which drags white
//! itself down — a knee at 0.75 lands SDR white on 248 instead of 255,
//! reintroducing exactly the washed-out grey this module exists to
//! remove. Tightening the knee until white survives quantisation (it
//! has to clear 0.9956 linear) leaves so little headroom that a 2×
//! highlight and a 10× one both quantise to 255 regardless — the
//! roll-off stops doing anything before it stops costing anything.
//!
//! Given the choice, a screenshot tool wants the SDR range exact. Almost
//! everything anyone captures — windows, text, UI — lives there, and a
//! whole image being subtly wrong is far worse than the brightest few
//! percent of a highlight being flat. Recovering that headroom means
//! changing the output format, not the curve: an HDR-capable container
//! (AVIF, JXR, HEVC HDR10) with more than 8 bits per channel to spend.
//!
//! # What is deliberately *not* done
//!
//! No gamut mapping. scRGB expresses colours outside sRGB as negative
//! components; those are clamped rather than desaturated into range.
//! Doing it properly needs a colour-management pass, and the artefact it
//! would prevent (a slightly over-saturated edge on wide-gamut content)
//! is invisible next to the failure this module *does* fix.

/// scRGB's reference white, in nits. `1.0` in an scRGB buffer means
/// exactly this much light — the fixed point the format is defined
/// against, not a display characteristic.
pub const SCRGB_REFERENCE_WHITE_NITS: f32 = 80.0;

/// SDR white level to assume when the display won't say. 200 nits is
/// what Windows itself defaults an HDR desktop to, so a display that
/// fails to report is overwhelmingly likely to be sitting here anyway.
pub const DEFAULT_SDR_WHITE_NITS: f32 = 200.0;

/// Scale factor taking scRGB values to SDR-relative ones, where `1.0`
/// is the display's white.
///
/// An implausible reported level falls back to [`DEFAULT_SDR_WHITE_NITS`]
/// rather than being clamped into range. Clamping looks safer and isn't:
/// flooring the *nits* at some small number produces a correspondingly
/// enormous scale factor, so a display reporting zero would hand back a
/// solid white capture — a failure that is much harder to recognise
/// than a slightly mis-normalised one. Anything below the scRGB
/// reference white is treated as not-reported, because no desktop is
/// configured with an SDR white point dimmer than 80 nits.
pub fn sdr_scale(sdr_white_nits: f32) -> f32 {
    let nits = if sdr_white_nits.is_finite() && sdr_white_nits >= SCRGB_REFERENCE_WHITE_NITS {
        sdr_white_nits
    } else {
        DEFAULT_SDR_WHITE_NITS
    };
    SCRGB_REFERENCE_WHITE_NITS / nits
}

/// Linear → sRGB transfer function, per the sRGB spec's two-part curve.
pub fn linear_to_srgb(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// Tone-map one scRGB pixel to 8-bit sRGB.
///
/// Clamping happens per channel, before the transfer function. That
/// order matters for an out-of-gamut pixel: `powf` on a negative base
/// yields `NaN`, which quantises to a garbage value rather than to
/// black.
pub fn tone_map_pixel(r: f32, g: f32, b: f32, sdr_white_nits: f32) -> [u8; 3] {
    let scale = sdr_scale(sdr_white_nits);
    [
        quantize(linear_to_srgb(r * scale)),
        quantize(linear_to_srgb(g * scale)),
        quantize(linear_to_srgb(b * scale)),
    ]
}

/// `[0, 1]` → `[0, 255]`, rounding to nearest.
fn quantize(v: f32) -> u8 {
    // NaN survives `clamp` on floats, so it is caught here rather than
    // cast (which would land on 0 silently on some targets).
    if v.is_nan() {
        return 0;
    }
    (v * 255.0 + 0.5).clamp(0.0, 255.0) as u8
}

/// Tone-map a whole scRGB frame into RGBA8.
///
/// `pixels` is tightly packed RGBA already widened from half-float to
/// `f32`, four components per pixel. Alpha is carried through the
/// quantiser but not the transfer function: it is not light, and the
/// desktop's alpha is already `[0, 1]`.
///
/// Returns the RGBA8 buffer, `width * height * 4` bytes.
pub fn tone_map_frame(pixels: &[f32], width: u32, height: u32, sdr_white_nits: f32) -> Vec<u8> {
    let count = (width as usize) * (height as usize);
    let mut out = Vec::with_capacity(count * 4);
    // Truncating rather than panicking on a short buffer: a torn frame
    // costs the bottom rows, where refusing costs the whole capture.
    for px in pixels.chunks_exact(4).take(count) {
        let [r, g, b] = tone_map_pixel(px[0], px[1], px[2], sdr_white_nits);
        out.extend_from_slice(&[r, g, b, quantize(px[3])]);
    }
    // A short source leaves the tail unwritten; fill it so the buffer
    // always matches the dimensions it claims.
    out.resize(count * 4, 0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// scRGB value that reads as SDR white on a display reporting
    /// `nits`.
    fn sdr_white_at(nits: f32) -> f32 {
        nits / SCRGB_REFERENCE_WHITE_NITS
    }

    #[test]
    fn sdr_white_maps_to_full_white() {
        // The anchor the whole conversion hangs off. If this drifts,
        // every capture off an HDR display is uniformly too dark or too
        // bright — which is the exact bug being fixed, so it is worth
        // pinning at several reported white levels.
        for nits in [80.0, 200.0, 240.0, 480.0] {
            let w = sdr_white_at(nits);
            assert_eq!(
                tone_map_pixel(w, w, w, nits),
                [255, 255, 255],
                "SDR white at {nits} nits"
            );
        }
    }

    #[test]
    fn black_stays_black() {
        assert_eq!(tone_map_pixel(0.0, 0.0, 0.0, 200.0), [0, 0, 0]);
    }

    #[test]
    fn sdr_midtones_survive_the_trip_unchanged() {
        // The property that makes this safe to run on every HDR
        // capture: an ordinary window must come out of an HDR capture
        // looking exactly like it does out of an SDR one.
        let nits = 200.0;
        for level in [0.05f32, 0.18, 0.4, 0.5, 0.9] {
            let scrgb = level * sdr_white_at(nits);
            let px = tone_map_pixel(scrgb, scrgb, scrgb, nits);
            assert_eq!(
                px[0],
                quantize(linear_to_srgb(level)),
                "linear {level} should encode as plain sRGB"
            );
        }
    }

    #[test]
    fn the_reported_white_level_actually_changes_the_result() {
        // The normalisation step is the fix. A capture that ignored the
        // display's white level would produce the same pixel here for
        // both, and be wrong for at least one of them. Measured on a
        // midtone: white itself saturates either way, so it cannot tell
        // the two apart.
        let scrgb = 0.3 * sdr_white_at(200.0);
        let correct = tone_map_pixel(scrgb, scrgb, scrgb, 200.0);
        let ignoring = tone_map_pixel(scrgb, scrgb, scrgb, SCRGB_REFERENCE_WHITE_NITS);
        assert_eq!(correct[0], quantize(linear_to_srgb(0.3)));
        assert!(
            ignoring[0] > correct[0],
            "ignoring a 200-nit white level should read too bright"
        );
    }

    #[test]
    fn content_brighter_than_white_clamps() {
        // Documented, deliberate: see the module docs on the trade-off.
        // Pinned as a test so that changing it is a decision rather
        // than an accident.
        let nits = 200.0;
        let w = sdr_white_at(nits);
        assert_eq!(tone_map_pixel(2.0 * w, 2.0 * w, 2.0 * w, nits), [255; 3]);
    }

    #[test]
    fn extreme_values_saturate_rather_than_wrapping() {
        // The failure being guarded is a float→int cast of an
        // out-of-range value, which is not simply "too bright" — it
        // wraps, so a blown-out highlight can come back *black*.
        // All at or above SDR white for a 200-nit display (scRGB 2.5) —
        // scRGB 1.0 is a *midtone* there, not a highlight.
        for v in [2.5f32, 10.0, 100.0, 10_000.0, f32::MAX, f32::INFINITY] {
            assert_eq!(
                tone_map_pixel(v, v, v, 200.0),
                [255, 255, 255],
                "{v} did not saturate to white"
            );
        }
    }

    #[test]
    fn out_of_gamut_negatives_clamp_rather_than_wrapping() {
        // scRGB expresses colours outside sRGB as negative components.
        // Left unclamped these reach `powf` with a negative base and
        // come back NaN, which lands as a garbage pixel.
        let px = tone_map_pixel(-0.5, 0.5, -0.2, 200.0);
        assert_eq!(px[0], 0);
        assert_eq!(px[2], 0);
        assert!(px[1] > 0);
    }

    #[test]
    fn a_nan_component_reads_as_black_not_as_noise() {
        let px = tone_map_pixel(f32::NAN, 0.0, 0.0, 200.0);
        assert_eq!(px, [0, 0, 0]);
    }

    #[test]
    fn a_neutral_pixel_stays_neutral() {
        // Any per-channel divergence would tint the whole desktop.
        let nits = 200.0;
        for level in [0.1f32, 0.5, 0.8] {
            let v = level * sdr_white_at(nits);
            let px = tone_map_pixel(v, v, v, nits);
            assert_eq!(px[0], px[1]);
            assert_eq!(px[1], px[2]);
        }
    }

    #[test]
    fn the_mapping_is_monotonic() {
        // Brighter input must never produce darker output, or a
        // gradient inverts.
        let mut prev = 0u8;
        let mut v = 0.0f32;
        while v < 4.0 {
            let out = tone_map_pixel(v, v, v, 200.0)[0];
            assert!(out >= prev, "output dipped at {v}");
            prev = out;
            v += 0.005;
        }
    }

    #[test]
    fn srgb_transfer_matches_its_known_anchors() {
        assert!((linear_to_srgb(0.0) - 0.0).abs() < 1e-6);
        assert!((linear_to_srgb(1.0) - 1.0).abs() < 1e-6);
        // Mid-grey: linear 0.2140 is sRGB 0.5 by definition of the curve.
        assert!((linear_to_srgb(0.2140) - 0.5).abs() < 1e-3);
    }

    #[test]
    fn a_display_reporting_nonsense_falls_back_to_the_default() {
        // Zero, negative and NaN all mean "didn't report", and all must
        // land on the same sane default rather than scaling the frame
        // into a white rectangle.
        let expected = sdr_scale(DEFAULT_SDR_WHITE_NITS);
        for bogus in [0.0f32, -50.0, f32::NAN, f32::INFINITY, 12.0] {
            assert_eq!(sdr_scale(bogus), expected, "{bogus} was not rejected");
        }
        let px = tone_map_pixel(0.1, 0.1, 0.1, 0.0);
        assert!(px[0] < 255, "a bogus white level whited out the capture");
    }

    #[test]
    fn a_frame_maps_to_the_dimensions_it_claims() {
        let w = sdr_white_at(200.0);
        let pixels = vec![w, w, w, 1.0, 0.0, 0.0, 0.0, 1.0];
        let out = tone_map_frame(&pixels, 2, 1, 200.0);
        assert_eq!(out.len(), 2 * 4);
        assert_eq!(&out[0..4], &[255, 255, 255, 255]);
        assert_eq!(&out[4..8], &[0, 0, 0, 255]);
    }

    #[test]
    fn a_short_frame_is_padded_rather_than_panicking() {
        // A torn grab should cost the bottom rows, not the capture.
        let out = tone_map_frame(&[1.0, 1.0, 1.0, 1.0], 4, 4, 200.0);
        assert_eq!(out.len(), 4 * 4 * 4);
    }
}
