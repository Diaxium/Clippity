//! Seeded corpora for the Clippity benchmark harness (performance
//! roadmap P2).
//!
//! Everything here is **synthetic and deterministic**. Benchmarks must
//! never read a real capture, a real window title or any user data — the
//! roadmap's own constraint is "collect timings and sizes only". A fixed
//! seed also makes runs comparable: the same corpus is regenerated
//! byte-for-byte on every machine, so a percentile shift is a code change,
//! not a different input.
//!
//! The generators are cheap but not trivial: frames carry real per-pixel
//! variation so the PNG encoder and the stitch compositor do the work
//! they would on a screenshot, rather than collapsing a flat color.

use clippity_domain::library::{CaptureKind, CaptureMeta};
use clippity_services::library_index::Stamp;
use image::{Rgba, RgbaImage};

/// A xorshift64\* step. Small, allocation-free and fully deterministic —
/// we only need spread, not cryptographic quality.
#[inline]
fn next_u64(state: &mut u64) -> u64 {
    let mut x = *state;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    *state = x;
    x.wrapping_mul(0x2545_F491_4F6C_DD1D)
}

/// A synthetic frame with plausible screenshot-like entropy: a diagonal
/// gradient perturbed by a cheap per-pixel hash. `seed` shifts the whole
/// field so successive scroll frames differ (as a scrolling surface
/// would) without changing cost.
pub fn synthetic_frame(width: u32, height: u32, seed: u64) -> RgbaImage {
    let mut img = RgbaImage::new(width, height);
    for (x, y, px) in img.enumerate_pixels_mut() {
        let base = (x.wrapping_add(y).wrapping_add(seed as u32)) as u8;
        let mut h = (x as u64) << 32 ^ (y as u64) ^ seed.rotate_left(17);
        let noise = (next_u64(&mut h) & 0x3f) as u8;
        *px = Rgba([
            base.wrapping_add(noise),
            base.wrapping_mul(3).wrapping_add(noise),
            base.wrapping_mul(7),
            0xff,
        ]);
    }
    img
}

/// A vertical scroll capture: `count` overlapping frames and their
/// cumulative offsets, as the scroll worker would hand them to
/// [`clippity_domain::scroll::stitch`]. `step` is the per-frame advance
/// in pixels (smaller than `height`, so frames overlap the way a real
/// scroll does).
pub fn scroll_corpus(
    count: usize,
    width: u32,
    height: u32,
    step: i32,
) -> (Vec<RgbaImage>, Vec<(i32, i32)>) {
    let frames: Vec<RgbaImage> = (0..count)
        .map(|i| synthetic_frame(width, height, i as u64 * 131))
        .collect();
    let offsets: Vec<(i32, i32)> = (0..count).map(|i| (0, i as i32 * step)).collect();
    (frames, offsets)
}

/// `n` synthetic library rows with the stamp each would carry, ready for
/// [`clippity_services::library_index::LibraryIndex::put`]. Ids, titles
/// and timestamps are derived from the index so the corpus is stable and
/// ordering is well-defined (newest first, ties on id).
pub fn library_corpus(n: usize) -> Vec<(CaptureMeta, Stamp)> {
    let kinds = [CaptureKind::Image, CaptureKind::Video, CaptureKind::Gif];
    (0..n)
        .map(|i| {
            let id = format!("C:/captures/cap-{i:08}.png");
            let title = format!("cap-{i:08}");
            let created = 1_700_000_000_000u128 + i as u128 * 1_000;
            let size = 40_000 + (i as u64 % 4096) * 512;
            let mut meta =
                CaptureMeta::new(id, title, kinds[i % kinds.len()], created, size, false);
            // Provenance a real row carries, so the write exercises every
            // column rather than a mostly-null one.
            meta.source_app = Some("bench-app".to_string());
            meta.source_window = Some(format!("Window {}", i % 32));
            meta.mode = Some("Region".to_string());
            meta.width = Some(1920);
            meta.height = Some(1080);
            if i % 5 == 0 {
                meta.tags = vec!["work".to_string(), "review".to_string()];
            }
            let stamp = Stamp {
                mtime_ms: created as i64,
                size_bytes: size as i64,
                meta_ms: created as i64,
                labels_ms: if i % 5 == 0 { created as i64 } else { 0 },
            };
            (meta, stamp)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_reproducible_byte_for_byte() {
        let a = synthetic_frame(64, 48, 7);
        let b = synthetic_frame(64, 48, 7);
        assert_eq!(a.into_raw(), b.into_raw());
    }

    #[test]
    fn different_seeds_produce_different_frames() {
        let a = synthetic_frame(64, 48, 1);
        let b = synthetic_frame(64, 48, 2);
        assert_ne!(a.into_raw(), b.into_raw());
    }

    #[test]
    fn scroll_corpus_offsets_are_cumulative() {
        let (frames, offsets) = scroll_corpus(4, 32, 32, 10);
        assert_eq!(frames.len(), 4);
        assert_eq!(offsets, vec![(0, 0), (0, 10), (0, 20), (0, 30)]);
    }

    #[test]
    fn library_corpus_is_stable_and_sized() {
        let rows = library_corpus(1000);
        assert_eq!(rows.len(), 1000);
        assert_eq!(rows[0].0.id, "C:/captures/cap-00000000.png");
        // Regenerating gives the identical first/last identity.
        let again = library_corpus(1000);
        assert_eq!(rows[999].0.id, again[999].0.id);
        assert_eq!(rows[999].1.size_bytes, again[999].1.size_bytes);
    }
}
