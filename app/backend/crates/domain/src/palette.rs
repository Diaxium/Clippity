//! Palette quantization — pure, no I/O.
//!
//! Extracts a small set of representative colors from an image via
//! k-means clustering with a perceptual (CIE-LAB ΔE76) distance metric,
//! a saturation-weighted seed histogram, and perceptual de-duplication
//! (ported in spirit from the legacy TypeScript extractor, ADR 0006).
//! Hand-rolled (no color crate); runs on the backend's authoritative
//! snapshot crop and is unit-tested on synthetic images.

use std::cmp::Ordering;

use image::RgbaImage;

use crate::library::AuxColor;

/// Default swatch count for a palette capture.
pub const DEFAULT_PALETTE_COUNT: usize = 6;

/// Bounds for a user-chosen swatch count — clamps the persisted settings
/// value and any explicit IPC override. Two is the fewest that reads as a
/// "palette"; past ~16 the extra clusters stop being perceptually distinct
/// on a typical region and the dedup pass collapses them anyway.
pub const MIN_PALETTE_COUNT: usize = 2;
pub const MAX_PALETTE_COUNT: usize = 16;

/// Clamp a requested swatch count into `[MIN_PALETTE_COUNT,
/// MAX_PALETTE_COUNT]`. The single chokepoint both the settings accessor
/// and the `finish_palette_capture` command route through.
pub fn clamp_count(n: usize) -> usize {
    n.clamp(MIN_PALETTE_COUNT, MAX_PALETTE_COUNT)
}

/// Longest-edge cap for analysis — downsample bigger crops so the
/// histogram + k-means stay cheap regardless of region size.
const ANALYSIS_MAX_EDGE: u32 = 256;
/// k-means refinement iterations.
const KMEANS_ITERS: usize = 6;
/// Pixels at or below this alpha are ignored (freehand cutouts, fully
/// transparent regions) so they don't pull a cluster toward black.
const MIN_ALPHA: u8 = 16;
/// Perceptual-dedup thresholds (ΔE76), tried in order: keep only
/// clusters at least this far apart, relaxing until `count` survive.
const DEDUP_STEPS: [f64; 6] = [15.0, 11.0, 7.0, 3.0, 1.0, 0.0];

/// A working pixel: its color in both sRGB (for the centroid mean) and
/// CIE-LAB (for the perceptual distance), plus a saturation weight that
/// biases the result toward vivid colors over near-grays.
struct Px {
    rgb: [f64; 3],
    lab: [f64; 3],
    w: f64,
}

#[derive(Clone)]
struct Centroid {
    lab: [f64; 3],
    rgb: [f64; 3],
    weight: f64,
}

/// Extract up to `count` representative colors, most-dominant first.
/// Returns `[]` for an empty / fully-transparent image, and clamps to the
/// number of perceptually-distinct clusters actually found.
pub fn quantize(img: &RgbaImage, count: usize) -> Vec<AuxColor> {
    if count == 0 {
        return Vec::new();
    }
    let pixels = collect_pixels(img);
    if pixels.is_empty() {
        return Vec::new();
    }
    // Seed with up to 2×count of the heaviest histogram buckets, refine,
    // then perceptually de-duplicate down to `count`.
    let seeds = seed_centroids(&pixels, count * 2);
    let refined = kmeans(&pixels, seeds);
    let kept = dedup_take(refined, count);
    // Each swatch's proportion is its share of the total *kept* weight, so
    // the returned proportions sum to ~1.0 — they drive proportional swatch
    // widths and the "% of region" labels. Saturation-weighted (see
    // `collect_pixels`), so the share reflects visual prominence rather
    // than a raw opaque-pixel count.
    let total: f64 = kept.iter().map(|c| c.weight).sum();
    kept.iter().map(|c| to_aux(c, total)).collect()
}

/// Downsample to `ANALYSIS_MAX_EDGE` then keep opaque-enough pixels as
/// `Px` (sRGB + LAB + saturation weight).
fn collect_pixels(img: &RgbaImage) -> Vec<Px> {
    let small = downsample(img);
    let mut out = Vec::new();
    for p in small.pixels() {
        let [r, g, b, a] = p.0;
        if a < MIN_ALPHA {
            continue;
        }
        let (rf, gf, bf) = (r as f64, g as f64, b as f64);
        let max = rf.max(gf).max(bf);
        let min = rf.min(gf).min(bf);
        // HSV-style saturation; near-grays (max≈min) weigh ~0.3, vivid 1.0.
        let sat = if max <= 0.0 { 0.0 } else { (max - min) / max };
        out.push(Px {
            rgb: [rf, gf, bf],
            lab: srgb_to_lab(rf, gf, bf),
            w: 0.3 + 0.7 * sat,
        });
    }
    out
}

fn downsample(img: &RgbaImage) -> RgbaImage {
    let (w, h) = (img.width(), img.height());
    let longest = w.max(h);
    if longest <= ANALYSIS_MAX_EDGE {
        return img.clone();
    }
    let scale = ANALYSIS_MAX_EDGE as f64 / longest as f64;
    let nw = ((w as f64 * scale).round() as u32).max(1);
    let nh = ((h as f64 * scale).round() as u32).max(1);
    image::imageops::thumbnail(img, nw, nh)
}

/// 5-bit (32-level) RGB histogram; the heaviest `k` buckets become the
/// initial centroids (weighted-mean color of each bucket).
fn seed_centroids(pixels: &[Px], k: usize) -> Vec<Centroid> {
    use std::collections::HashMap;
    let mut buckets: HashMap<u32, ([f64; 3], f64)> = HashMap::new();
    for p in pixels {
        let key = (((p.rgb[0] as u32) >> 3) << 10)
            | (((p.rgb[1] as u32) >> 3) << 5)
            | ((p.rgb[2] as u32) >> 3);
        let e = buckets.entry(key).or_insert(([0.0; 3], 0.0));
        e.0[0] += p.rgb[0] * p.w;
        e.0[1] += p.rgb[1] * p.w;
        e.0[2] += p.rgb[2] * p.w;
        e.1 += p.w;
    }
    let mut seeds: Vec<Centroid> = buckets
        .values()
        .map(|(sum, w)| {
            let rgb = [sum[0] / w, sum[1] / w, sum[2] / w];
            Centroid {
                lab: srgb_to_lab(rgb[0], rgb[1], rgb[2]),
                rgb,
                weight: *w,
            }
        })
        .collect();
    seeds.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(Ordering::Equal));
    seeds.truncate(k.max(1));
    seeds
}

/// Assign each pixel to its nearest centroid (by ΔE76) and move each
/// centroid to the weighted mean of its members, for a fixed number of
/// iterations. Empty clusters drop to zero weight.
fn kmeans(pixels: &[Px], mut centroids: Vec<Centroid>) -> Vec<Centroid> {
    for _ in 0..KMEANS_ITERS {
        let mut acc = vec![([0.0_f64; 3], 0.0_f64); centroids.len()];
        for p in pixels {
            let mut best = 0;
            let mut best_d = f64::INFINITY;
            for (i, c) in centroids.iter().enumerate() {
                let d = delta_e_sq(p.lab, c.lab);
                if d < best_d {
                    best_d = d;
                    best = i;
                }
            }
            acc[best].0[0] += p.rgb[0] * p.w;
            acc[best].0[1] += p.rgb[1] * p.w;
            acc[best].0[2] += p.rgb[2] * p.w;
            acc[best].1 += p.w;
        }
        for (i, c) in centroids.iter_mut().enumerate() {
            let (sum, w) = acc[i];
            if w > 0.0 {
                c.rgb = [sum[0] / w, sum[1] / w, sum[2] / w];
                c.lab = srgb_to_lab(c.rgb[0], c.rgb[1], c.rgb[2]);
                c.weight = w;
            } else {
                c.weight = 0.0;
            }
        }
    }
    centroids
}

/// Greedily keep the heaviest clusters that are at least `thresh` ΔE
/// apart, relaxing the threshold until `count` survive (or colors run
/// out). Output is ordered most-dominant first.
fn dedup_take(mut centroids: Vec<Centroid>, count: usize) -> Vec<Centroid> {
    centroids.retain(|c| c.weight > 0.0);
    centroids.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(Ordering::Equal));
    for &thresh in &DEDUP_STEPS {
        let t2 = thresh * thresh;
        let mut kept: Vec<Centroid> = Vec::new();
        for c in &centroids {
            if kept.iter().all(|k| delta_e_sq(k.lab, c.lab) >= t2) {
                kept.push(c.clone());
                if kept.len() >= count {
                    break;
                }
            }
        }
        if kept.len() >= count || thresh == 0.0 {
            return kept;
        }
    }
    centroids.into_iter().take(count).collect()
}

fn to_aux(c: &Centroid, total_weight: f64) -> AuxColor {
    let r = c.rgb[0].round().clamp(0.0, 255.0) as u8;
    let g = c.rgb[1].round().clamp(0.0, 255.0) as u8;
    let b = c.rgb[2].round().clamp(0.0, 255.0) as u8;
    let proportion = (total_weight > 0.0).then(|| c.weight / total_weight);
    AuxColor {
        hex: format!("#{r:02X}{g:02X}{b:02X}"),
        r,
        g,
        b,
        proportion,
    }
}

/// Squared ΔE76 (Euclidean distance in CIE-LAB). Squared so callers can
/// compare against `thresh²` without a square root per comparison.
fn delta_e_sq(a: [f64; 3], b: [f64; 3]) -> f64 {
    let dl = a[0] - b[0];
    let da = a[1] - b[1];
    let db = a[2] - b[2];
    dl * dl + da * da + db * db
}

/// sRGB (0-255 components) → CIE-LAB (D65 white point).
fn srgb_to_lab(r: f64, g: f64, b: f64) -> [f64; 3] {
    let lin = |c: f64| {
        let c = c / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let (r, g, b) = (lin(r), lin(g), lin(b));
    // Linear sRGB → XYZ (D65).
    let x = r * 0.4124 + g * 0.3576 + b * 0.1805;
    let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    let z = r * 0.0193 + g * 0.1192 + b * 0.9505;
    // Normalize to the D65 white point, then the LAB f() transfer.
    let f = |t: f64| {
        if t > 0.008856 {
            t.cbrt()
        } else {
            7.787 * t + 16.0 / 116.0
        }
    };
    let fx = f(x / 0.95047);
    let fy = f(y / 1.0);
    let fz = f(z / 1.08883);
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, rgba: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, image::Rgba(rgba))
    }

    /// Find a returned swatch whose dominant channel is `dom` and others
    /// are low — i.e. "this primary color is represented".
    fn has_primary(colors: &[AuxColor], dom: char) -> bool {
        colors.iter().any(|c| match dom {
            'r' => c.r > 200 && c.g < 70 && c.b < 70,
            'g' => c.g > 200 && c.r < 70 && c.b < 70,
            'b' => c.b > 200 && c.r < 70 && c.g < 70,
            _ => false,
        })
    }

    #[test]
    fn quantize_solid_image_returns_one_dominant_swatch() {
        let img = solid(24, 24, [200, 40, 40, 255]);
        let pal = quantize(&img, 6);
        assert_eq!(pal.len(), 1, "a solid image has one distinct color");
        assert!(
            pal[0].r > 180 && pal[0].g < 80 && pal[0].b < 80,
            "{:?}",
            pal[0]
        );
        assert!(pal[0].hex.starts_with('#') && pal[0].hex.len() == 7);
    }

    #[test]
    fn quantize_three_blocks_recovers_each_primary() {
        // 30×10: red | green | blue thirds (pure, no AA).
        let mut img = RgbaImage::new(30, 10);
        for (x, _y, px) in img.enumerate_pixels_mut() {
            *px = if x < 10 {
                image::Rgba([255, 0, 0, 255])
            } else if x < 20 {
                image::Rgba([0, 255, 0, 255])
            } else {
                image::Rgba([0, 0, 255, 255])
            };
        }
        let pal = quantize(&img, 3);
        assert_eq!(pal.len(), 3, "three distinct blocks → three swatches");
        assert!(has_primary(&pal, 'r'), "red missing: {pal:?}");
        assert!(has_primary(&pal, 'g'), "green missing: {pal:?}");
        assert!(has_primary(&pal, 'b'), "blue missing: {pal:?}");
    }

    #[test]
    fn quantize_clamps_to_distinct_colors() {
        // Two-color image, asked for 6 → only 2 distinct survive.
        let mut img = RgbaImage::new(20, 10);
        for (x, _y, px) in img.enumerate_pixels_mut() {
            *px = if x < 10 {
                image::Rgba([10, 10, 10, 255])
            } else {
                image::Rgba([240, 240, 240, 255])
            };
        }
        let pal = quantize(&img, 6);
        assert_eq!(pal.len(), 2, "got {pal:?}");
    }

    #[test]
    fn quantize_empty_or_transparent_or_zero_count_is_empty() {
        assert!(quantize(&RgbaImage::new(0, 0), 6).is_empty());
        assert!(
            quantize(&solid(8, 8, [255, 0, 0, 0]), 6).is_empty(),
            "fully transparent"
        );
        assert!(
            quantize(&solid(8, 8, [255, 0, 0, 255]), 0).is_empty(),
            "count 0"
        );
    }

    #[test]
    fn quantize_reports_proportions_dominant_first_summing_to_one() {
        // 40×10: 30 columns red, 10 columns blue → red is the majority.
        let mut img = RgbaImage::new(40, 10);
        for (x, _y, px) in img.enumerate_pixels_mut() {
            *px = if x < 30 {
                image::Rgba([255, 0, 0, 255])
            } else {
                image::Rgba([0, 0, 255, 255])
            };
        }
        let pal = quantize(&img, 6);
        assert_eq!(pal.len(), 2, "two distinct colors: {pal:?}");
        // Every swatch carries a proportion, and they sum to ~1.
        let sum: f64 = pal
            .iter()
            .map(|c| c.proportion.expect("proportion set"))
            .sum();
        assert!((sum - 1.0).abs() < 1e-6, "proportions sum to 1, got {sum}");
        // Ordered most-dominant first, and the leader is the red majority.
        assert!(
            pal[0].proportion.unwrap() >= pal[1].proportion.unwrap(),
            "dominant first: {pal:?}"
        );
        assert!(pal[0].r > 180 && pal[0].b < 80, "red leads: {:?}", pal[0]);
        // Red covers ~3× blue (both fully saturated → weight ≈ pixel count).
        assert!(pal[0].proportion.unwrap() > 0.6, "{pal:?}");
    }

    #[test]
    fn clamp_count_bounds_into_range() {
        assert_eq!(clamp_count(0), MIN_PALETTE_COUNT);
        assert_eq!(clamp_count(1), MIN_PALETTE_COUNT);
        assert_eq!(clamp_count(6), 6);
        assert_eq!(clamp_count(999), MAX_PALETTE_COUNT);
    }
}
