//! "Smart enhance" — the optional post-crop clean-up pass behind the
//! overlay's Sparkles toggle.
//!
//! Pure pixel math on an `RgbaImage`, no I/O — same arrangement as
//! `domain::palette`, which also takes decoded images. Applied by the
//! capture pipelines immediately before PNG encoding, so it affects the
//! saved file and the clipboard copy alike.
//!
//! Two steps, both tuned for *screenshots* rather than photographs:
//!
//! 1. **Auto-levels** — stretch the tonal range when the capture is
//!    washed out (a dimmed window, a low-contrast dark theme, an HDR
//!    surface tone-mapped flat). Computed on luminance and applied
//!    equally to R/G/B so hues don't shift — a per-channel stretch would
//!    tint neutral UI grey, which is exactly what a screenshot is full of.
//! 2. **Unsharp mask** — a light crispen so downscaled text stays
//!    legible.
//!
//! Both steps are **alpha-aware**: fully transparent pixels are ignored
//! when measuring and never written, and the blur normalizes by
//! neighbour alpha. Without that, the transparent surround of a Freehand
//! or Brush cut-out would bleed a dark halo along the cut edge.
//!
//! Both steps are also **no-ops on content that doesn't need them**: an
//! image already spanning the tonal range is not stretched at all, so
//! enhancing a normal screenshot changes nothing but the sharpening.

use image::RgbaImage;

/// Fraction of pixels ignored at each end of the histogram when finding
/// the black/white points. Keeps a single blown-out highlight or one
/// black drop-shadow pixel from pinning the range to 0..255 and making
/// the stretch a no-op.
const CLIP_FRACTION: f32 = 0.005;

/// Minimum luminance span (of 255) that counts as "already using the
/// range". Above this the stretch is skipped entirely — the gain would
/// be under ~1.09, which is invisible and only risks clipping.
const ALREADY_STRETCHED_SPAN: u32 = 235;

/// Unsharp-mask strength. Deliberately mild: screenshots are already
/// pixel-exact, so this is about recovering edge contrast, not the
/// halo-heavy "sharpen" of photo tools.
const UNSHARP_AMOUNT: f32 = 0.55;

/// Run the enhancement pass over `img` in place.
///
/// Safe to call on any capture, including transparent cut-outs and
/// single-pixel images; it degrades to a no-op rather than erroring.
pub fn smart_enhance(img: &mut RgbaImage) {
    if let Some((lo, hi)) = levels_window(img) {
        apply_levels(img, lo, hi);
    }
    apply_unsharp(img, UNSHARP_AMOUNT);
}

/// Rec. 601 luma of an RGB triple, rounded to a `u8` histogram bin.
/// Integer math — this runs once per pixel over a multi-megapixel canvas.
fn luma(r: u8, g: u8, b: u8) -> u8 {
    ((r as u32 * 77 + g as u32 * 150 + b as u32 * 29) >> 8) as u8
}

/// The black/white points to stretch between, or `None` when no stretch
/// should happen — either the image is already using the range, is
/// entirely transparent, or is flat (a solid colour, where stretching
/// would amplify nothing into everything).
///
/// Pure and separated from [`apply_levels`] so the decision is testable
/// without touching pixels.
fn levels_window(img: &RgbaImage) -> Option<(u8, u8)> {
    let mut histogram = [0u32; 256];
    let mut counted = 0u32;
    for px in img.pixels() {
        // Transparent pixels carry no visible tone — a Freehand cut-out
        // is mostly transparent, and counting it would drag the black
        // point to 0 and disable the stretch entirely.
        if px.0[3] == 0 {
            continue;
        }
        histogram[luma(px.0[0], px.0[1], px.0[2]) as usize] += 1;
        counted += 1;
    }
    if counted == 0 {
        return None;
    }

    let clip = (counted as f32 * CLIP_FRACTION) as u32;
    let lo = percentile_bin(&histogram, clip, false);
    let hi = percentile_bin(&histogram, clip, true);
    // A flat image has no range to stretch; `hi <= lo` also guards the
    // division in `apply_levels`.
    if hi <= lo {
        return None;
    }
    if (hi - lo) as u32 >= ALREADY_STRETCHED_SPAN {
        return None;
    }
    Some((lo, hi))
}

/// Walk `histogram` from one end, skipping `clip` pixels, and return the
/// bin where the (clipped) content starts. `from_top` walks downward for
/// the white point.
fn percentile_bin(histogram: &[u32; 256], clip: u32, from_top: bool) -> u8 {
    let mut seen = 0u32;
    let range: Box<dyn Iterator<Item = usize>> = if from_top {
        Box::new((0..256).rev())
    } else {
        Box::new(0..256)
    };
    let mut last = if from_top { 255 } else { 0 };
    for i in range {
        seen += histogram[i];
        last = i;
        if seen > clip {
            break;
        }
    }
    last as u8
}

/// Linearly remap `lo..=hi` onto `0..=255`, applying the same gain to
/// every channel so neutrals stay neutral. Alpha is untouched and fully
/// transparent pixels are left exactly as they were.
fn apply_levels(img: &mut RgbaImage, lo: u8, hi: u8) {
    // Precomputed lookup — 256 entries beats a float multiply per
    // channel per pixel.
    let span = (hi - lo) as f32;
    let mut lut = [0u8; 256];
    for (value, slot) in lut.iter_mut().enumerate() {
        let scaled = ((value as f32 - lo as f32) / span * 255.0).round();
        *slot = scaled.clamp(0.0, 255.0) as u8;
    }
    for px in img.pixels_mut() {
        if px.0[3] == 0 {
            continue;
        }
        px.0[0] = lut[px.0[0] as usize];
        px.0[1] = lut[px.0[1] as usize];
        px.0[2] = lut[px.0[2] as usize];
    }
}

/// 3×3 gaussian weights (`[1 2 1; 2 4 2; 1 2 1]`), flattened row-major.
const BLUR_KERNEL: [i32; 9] = [1, 2, 1, 2, 4, 2, 1, 2, 1];

/// Unsharp mask: `out = src + amount * (src - blur(src))`.
///
/// The blur is alpha-weighted, so a neighbour that is fully transparent
/// contributes nothing rather than contributing black — that's what
/// keeps a cut-out's edge from picking up a dark rim. Pixels whose whole
/// neighbourhood is transparent are left alone.
fn apply_unsharp(img: &mut RgbaImage, amount: f32) {
    let (w, h) = (img.width(), img.height());
    if w < 3 || h < 3 || amount <= 0.0 {
        // Nothing to convolve against — a 1- or 2-px strip has no
        // interior pixel with a full neighbourhood.
        return;
    }
    let source = img.clone();

    for y in 0..h {
        for x in 0..w {
            let px = source.get_pixel(x, y);
            if px.0[3] == 0 {
                continue;
            }
            let mut acc = [0i32; 3];
            let mut weight_sum = 0i32;
            for ky in 0..3i32 {
                for kx in 0..3i32 {
                    // Clamp at the border so edge pixels convolve against
                    // themselves instead of against nothing.
                    let sx = (x as i32 + kx - 1).clamp(0, w as i32 - 1) as u32;
                    let sy = (y as i32 + ky - 1).clamp(0, h as i32 - 1) as u32;
                    let neighbour = source.get_pixel(sx, sy);
                    if neighbour.0[3] == 0 {
                        continue;
                    }
                    let k = BLUR_KERNEL[(ky * 3 + kx) as usize];
                    acc[0] += k * neighbour.0[0] as i32;
                    acc[1] += k * neighbour.0[1] as i32;
                    acc[2] += k * neighbour.0[2] as i32;
                    weight_sum += k;
                }
            }
            if weight_sum == 0 {
                continue;
            }
            let out = img.get_pixel_mut(x, y);
            for (c, &channel_sum) in acc.iter().enumerate() {
                let blurred = channel_sum as f32 / weight_sum as f32;
                let original = px.0[c] as f32;
                let sharpened = original + amount * (original - blurred);
                out.0[c] = sharpened.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// Solid `w`×`h` image of one colour.
    fn solid(w: u32, h: u32, px: Rgba<u8>) -> RgbaImage {
        RgbaImage::from_pixel(w, h, px)
    }

    #[test]
    fn luma_weights_green_heaviest() {
        assert_eq!(luma(0, 0, 0), 0);
        assert_eq!(luma(255, 255, 255), 255);
        assert!(luma(0, 255, 0) > luma(255, 0, 0));
        assert!(luma(255, 0, 0) > luma(0, 0, 255));
    }

    #[test]
    fn a_washed_out_image_gets_a_stretch_window() {
        // Every pixel between 100 and 140 — a badly dimmed capture.
        let mut img = RgbaImage::new(10, 10);
        for (i, px) in img.pixels_mut().enumerate() {
            let v = 100 + (i % 41) as u8;
            *px = Rgba([v, v, v, 255]);
        }
        let (lo, hi) = levels_window(&img).expect("a narrow range should stretch");
        assert!(lo >= 100, "black point {lo} should sit at the low end");
        assert!(hi <= 140, "white point {hi} should sit at the high end");
    }

    #[test]
    fn an_image_already_spanning_the_range_is_not_stretched() {
        // Half pure black, half pure white — nothing to gain.
        let mut img = RgbaImage::new(10, 10);
        for (i, px) in img.pixels_mut().enumerate() {
            let v = if i % 2 == 0 { 0 } else { 255 };
            *px = Rgba([v, v, v, 255]);
        }
        assert_eq!(levels_window(&img), None);
    }

    #[test]
    fn a_flat_image_is_not_stretched() {
        // Stretching a solid colour would map it to either 0 or 255.
        let img = solid(4, 4, Rgba([128, 128, 128, 255]));
        assert_eq!(levels_window(&img), None);
    }

    #[test]
    fn a_fully_transparent_image_is_not_stretched() {
        let img = solid(4, 4, Rgba([10, 20, 30, 0]));
        assert_eq!(levels_window(&img), None);
    }

    #[test]
    fn transparent_pixels_do_not_drag_the_black_point_down() {
        // A cut-out: a mid-tone subject surrounded by transparency. If
        // the transparent surround were counted as black the range would
        // read as 0..~130 and the stretch would blow the subject out.
        let mut img = RgbaImage::new(10, 10);
        for (i, px) in img.pixels_mut().enumerate() {
            *px = if i < 50 {
                Rgba([0, 0, 0, 0])
            } else {
                let v = 120 + (i % 20) as u8;
                Rgba([v, v, v, 255])
            };
        }
        let (lo, _) = levels_window(&img).expect("the opaque subject is narrow-range");
        assert!(lo >= 120, "black point {lo} came from the transparent half");
    }

    #[test]
    fn apply_levels_maps_the_window_onto_the_full_range() {
        let mut img = RgbaImage::new(2, 1);
        img.put_pixel(0, 0, Rgba([100, 100, 100, 255]));
        img.put_pixel(1, 0, Rgba([140, 140, 140, 255]));
        apply_levels(&mut img, 100, 140);
        assert_eq!(img.get_pixel(0, 0).0[0], 0);
        assert_eq!(img.get_pixel(1, 0).0[0], 255);
    }

    #[test]
    fn apply_levels_keeps_neutral_grey_neutral() {
        // A per-channel stretch would tint this; a luma-driven one can't.
        let mut img = RgbaImage::new(2, 1);
        img.put_pixel(0, 0, Rgba([110, 110, 110, 255]));
        img.put_pixel(1, 0, Rgba([130, 130, 130, 255]));
        apply_levels(&mut img, 100, 140);
        for px in img.pixels() {
            assert_eq!(px.0[0], px.0[1]);
            assert_eq!(px.0[1], px.0[2]);
        }
    }

    #[test]
    fn enhance_preserves_alpha_exactly() {
        let mut img = RgbaImage::new(5, 5);
        for (i, px) in img.pixels_mut().enumerate() {
            *px = Rgba([100, 110, 120, (i * 10) as u8]);
        }
        let before: Vec<u8> = img.pixels().map(|p| p.0[3]).collect();
        smart_enhance(&mut img);
        let after: Vec<u8> = img.pixels().map(|p| p.0[3]).collect();
        assert_eq!(before, after);
    }

    #[test]
    fn enhance_leaves_fully_transparent_pixels_untouched() {
        // The cut-out surround must come out bit-identical — any bleed
        // here is a visible halo in a Freehand or Brush capture.
        let mut img = RgbaImage::new(5, 5);
        for (i, px) in img.pixels_mut().enumerate() {
            *px = if i % 2 == 0 {
                Rgba([0, 0, 0, 0])
            } else {
                Rgba([200, 40, 40, 255])
            };
        }
        smart_enhance(&mut img);
        for (i, px) in img.pixels().enumerate() {
            if i % 2 == 0 {
                assert_eq!(px.0, [0, 0, 0, 0], "transparent pixel {i} was written to");
            }
        }
    }

    #[test]
    fn unsharp_increases_contrast_across_an_edge() {
        // Left half dark, right half light: sharpening should push the
        // pixels flanking the seam further apart, not closer.
        let mut img = RgbaImage::new(6, 6);
        for y in 0..6 {
            for x in 0..6 {
                let v = if x < 3 { 90 } else { 160 };
                img.put_pixel(x, y, Rgba([v, v, v, 255]));
            }
        }
        let before = (
            img.get_pixel(2, 3).0[0] as i32,
            img.get_pixel(3, 3).0[0] as i32,
        );
        apply_unsharp(&mut img, UNSHARP_AMOUNT);
        let after = (
            img.get_pixel(2, 3).0[0] as i32,
            img.get_pixel(3, 3).0[0] as i32,
        );
        assert!(after.0 < before.0, "the dark side should darken");
        assert!(after.1 > before.1, "the light side should lighten");
    }

    #[test]
    fn unsharp_is_a_no_op_on_a_flat_image() {
        // No edges means nothing to sharpen — a solid fill must survive
        // untouched rather than picking up rounding drift.
        let mut img = solid(6, 6, Rgba([123, 45, 67, 255]));
        apply_unsharp(&mut img, UNSHARP_AMOUNT);
        for px in img.pixels() {
            assert_eq!(px.0, [123, 45, 67, 255]);
        }
    }

    #[test]
    fn enhance_survives_degenerate_sizes() {
        // 1×1 and 2×2 have no interior pixel; the pass must skip the
        // convolution rather than panic on the border arithmetic.
        for (w, h) in [(1, 1), (2, 2), (1, 40), (40, 1)] {
            let mut img = solid(w, h, Rgba([10, 200, 30, 255]));
            smart_enhance(&mut img);
            assert_eq!(img.dimensions(), (w, h));
        }
    }
}
