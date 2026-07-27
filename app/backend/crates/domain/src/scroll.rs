//! Scroll-stitch algorithms — pure, no I/O.
//!
//! Reconstructs a region taller (or wider, for panoramic) than the
//! screen from a stream of overlapping frames the user produced by
//! scrolling. Three pieces (ported from the legacy `capture.rs`):
//!
//! - [`frame_difference`] — cheap strided SSD; the recording worker's
//!   gate to drop near-duplicate frames (scroll paused / cursor jitter).
//! - [`detect_offset`] — how far the content translated between two
//!   consecutive frames, via a mean-SSD grid search on downscaled
//!   thumbnails.
//! - [`stitch`] — composite frames onto one auto-sized canvas at their
//!   pre-computed **cumulative** offsets (the service accumulates them
//!   incrementally, so this stays a pure placement function — ADR 0008).

use image::RgbaImage;
use serde::{Deserialize, Serialize};

/// Coarse-thumbnail resolution along the **scroll axis** — kept high so
/// the offset search has detail to lock onto. Crucially this is applied
/// to the scroll axis *specifically* (a non-uniform resize), so a custom
/// selection that's wide-but-short (or tall-but-narrow) doesn't get its
/// scroll axis crushed the way a longest-edge downscale would. A
/// full-resolution refinement pass then removes the residual
/// quantization (see [`detect_offset`]).
pub const COARSE_SCROLL_RES: u32 = 200;

/// Coarse-thumbnail resolution along the **cross axis** (perpendicular to
/// the scroll). Lower than the scroll axis — the cross axis only needs
/// enough texture to make the SSD match meaningful, not to resolve the
/// offset.
pub const COARSE_CROSS_RES: u32 = 120;

/// Mean-SSD below this means two consecutive frames are visually
/// identical (the user hasn't scrolled) — the worker skips the frame so
/// pauses don't bloat the stitch input.
pub const FRAME_DEDUP_THRESHOLD: f64 = 80.0;

/// Sampling stride for the full-resolution refinement SSD. Every 3rd
/// pixel keeps the refine pass fast on large regions while staying
/// pixel-accurate (the alignment minimum is unaffected by subsampling a
/// translation).
const FINE_STRIDE: i32 = 3;

/// Extra full-res pixels searched on each side of the coarse estimate,
/// beyond the downscale quantization it has to undo.
const REFINE_MARGIN: i32 = 3;

/// Cap on the refinement radius so the fine search stays bounded even
/// for very large regions (where the downscale quantization is biggest).
const REFINE_MAX_RADIUS: i32 = 24;

/// A candidate offset must keep at least this fraction of the frame
/// overlapping to be scored — rejects the tiny-overlap shifts whose
/// near-empty SSD can spuriously beat the true alignment.
const MIN_OVERLAP_FRACTION: f64 = 0.12;

// ---- Panoramic auto-scroll step calibration ----
//
// The panoramic worker must never advance the content by more than a
// fraction of the capture region per step, or consecutive frames stop
// overlapping and `detect_offset` can't align them (the stitch collapses
// into an overlapping jumble — the single-`Box-row` failure). The wheel's
// pixels-per-unit varies wildly by app/DPI/OS scroll settings, so the
// worker *calibrates* the step from the measured advance rather than using
// a fixed notch count.

/// Fraction of the region's along-scroll extent one step should advance
/// the content. Well under 1.0 so each pair of frames keeps a generous
/// overlap for the detector to lock onto.
pub const AUTO_STEP_ADVANCE_FRACTION: f64 = 0.55;

/// Wheel-delta bounds for one auto-scroll step, in `WHEEL_DELTA` units
/// (120 = one physical notch). `MIN` is the responsive floor (the worker
/// starts here so the first, un-calibrated step can't outrun a short
/// region; too small and some apps ignore the event). `MAX` bounds a
/// single jump on a tall region (≈ the legacy 2-notch step).
pub const AUTO_WHEEL_DELTA_MIN: i32 = 30;
pub const AUTO_WHEEL_DELTA_MAX: i32 = 240;

/// Normalized cross-correlation at the detected offset must be at least
/// this for [`detect_offset_confident`] to call the match confident (the
/// frames genuinely overlap). A step that outran the region leaves
/// uncorrelated content (NCC ≈ 0) there.
pub const OFFSET_CONFIDENCE_NCC: f64 = 0.5;

/// Overlap floor for the confidence NCC — higher than the detector's
/// `MIN_OVERLAP_FRACTION` so a tiny, noisy edge overlap can't yield a
/// spuriously high correlation. Below this, the match is treated as not
/// confident (too little shared content to trust).
const CONF_MIN_OVERLAP_FRACTION: f64 = 0.3;

/// Signed-magnitude wheel delta (`WHEEL_DELTA` units) that advances the
/// content by ~[`AUTO_STEP_ADVANCE_FRACTION`] of `region_extent`, given a
/// measured `px_per_unit`. Clamped to `[MIN, MAX]`. Pure; the worker reads
/// `px_per_unit` back from each step's detected offset and re-calibrates.
pub fn calibrated_wheel_delta(region_extent: u32, px_per_unit: f64) -> i32 {
    if px_per_unit <= 0.0 {
        return AUTO_WHEEL_DELTA_MIN;
    }
    let target = AUTO_STEP_ADVANCE_FRACTION * region_extent as f64;
    let units = (target / px_per_unit).round() as i32;
    units.clamp(AUTO_WHEEL_DELTA_MIN, AUTO_WHEEL_DELTA_MAX)
}

/// Mean SSD (over RGB) of the overlapping region when `next` is shifted
/// by `(dx, dy)` relative to `prev`, sampling every `stride` pixels.
/// `None` when the shift leaves less than [`MIN_OVERLAP_FRACTION`] of the
/// frame overlapping (or no overlap at all). Lower = better alignment.
fn ssd_overlap(prev: &RgbaImage, next: &RgbaImage, dx: i32, dy: i32, stride: i32) -> Option<f64> {
    let w = prev.width() as i32;
    let h = prev.height() as i32;
    let px_start = dx.max(0);
    let py_start = dy.max(0);
    let px_end = (w + dx.min(0)).min(w);
    let py_end = (h + dy.min(0)).min(h);
    if px_end <= px_start || py_end <= py_start {
        return None;
    }
    // Reject candidates with too little overlap — their SSD is computed
    // over so few pixels it can spuriously win.
    let overlap = (px_end - px_start) as i64 * (py_end - py_start) as i64;
    if (overlap as f64) < MIN_OVERLAP_FRACTION * (w as i64 * h as i64) as f64 {
        return None;
    }
    let stride = stride.max(1);
    let mut sum = 0u64;
    let mut count = 0u64;
    let mut y = py_start;
    while y < py_end {
        let mut x = px_start;
        while x < px_end {
            let pp = prev.get_pixel(x as u32, y as u32);
            let np = next.get_pixel((x - dx) as u32, (y - dy) as u32);
            let dr = pp[0] as i32 - np[0] as i32;
            let dg = pp[1] as i32 - np[1] as i32;
            let db = pp[2] as i32 - np[2] as i32;
            sum += (dr * dr + dg * dg + db * db) as u64;
            count += 1;
            x += stride;
        }
        y += stride;
    }
    (count > 0).then(|| sum as f64 / count as f64)
}

/// Pearson / normalized cross-correlation of the overlapping region's
/// (R+G+B) intensity when `next` is shifted by `(dx, dy)` relative to
/// `prev`, sampling every `stride` px. Returns `None` when the overlap is
/// below [`CONF_MIN_OVERLAP_FRACTION`] (too little to trust) or the
/// intensity is flat (zero variance — undefined correlation). +1 =
/// identical content, ~0 = uncorrelated. Used only by the confidence
/// check; alignment itself stays SSD-based.
fn ncc_overlap(prev: &RgbaImage, next: &RgbaImage, dx: i32, dy: i32, stride: i32) -> Option<f64> {
    let w = prev.width() as i32;
    let h = prev.height() as i32;
    let px_start = dx.max(0);
    let py_start = dy.max(0);
    let px_end = (w + dx.min(0)).min(w);
    let py_end = (h + dy.min(0)).min(h);
    if px_end <= px_start || py_end <= py_start {
        return None;
    }
    let overlap = (px_end - px_start) as i64 * (py_end - py_start) as i64;
    if (overlap as f64) < CONF_MIN_OVERLAP_FRACTION * (w as i64 * h as i64) as f64 {
        return None;
    }
    let stride = stride.max(1);
    let (mut n, mut sp, mut sn, mut spp, mut snn, mut spn) =
        (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut y = py_start;
    while y < py_end {
        let mut x = px_start;
        while x < px_end {
            let pp = prev.get_pixel(x as u32, y as u32);
            let np = next.get_pixel((x - dx) as u32, (y - dy) as u32);
            let p = pp[0] as f64 + pp[1] as f64 + pp[2] as f64;
            let q = np[0] as f64 + np[1] as f64 + np[2] as f64;
            n += 1.0;
            sp += p;
            sn += q;
            spp += p * p;
            snn += q * q;
            spn += p * q;
            x += stride;
        }
        y += stride;
    }
    let var_p = n * spp - sp * sp;
    let var_n = n * snn - sn * sn;
    let denom = (var_p * var_n).sqrt();
    if denom <= 0.0 {
        return None;
    }
    Some((n * spn - sp * sn) / denom)
}

/// Non-uniform downscale that preserves the **scroll axis**: the scroll
/// axis is capped at [`COARSE_SCROLL_RES`], the cross axis at the smaller
/// [`COARSE_CROSS_RES`]. Returns the thumbnail plus the scale applied to
/// the scroll axis (used to lift the coarse offset back to full res).
/// Unlike a longest-edge downscale, a wide-short or tall-narrow custom
/// selection keeps its scroll-axis detail.
fn axis_downscale(img: &RgbaImage, axis: ScrollAxis) -> (RgbaImage, f64) {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return (img.clone(), 1.0);
    }
    let (tw, th) = match axis {
        ScrollAxis::Vertical => (w.min(COARSE_CROSS_RES), h.min(COARSE_SCROLL_RES)),
        ScrollAxis::Horizontal => (w.min(COARSE_SCROLL_RES), h.min(COARSE_CROSS_RES)),
    };
    let tw = tw.max(1);
    let th = th.max(1);
    let scroll_scale = match axis {
        ScrollAxis::Vertical => th as f64 / h as f64,
        ScrollAxis::Horizontal => tw as f64 / w as f64,
    };
    if tw == w && th == h {
        return (img.clone(), scroll_scale);
    }
    let small = image::imageops::resize(img, tw, th, image::imageops::FilterType::Triangle);
    (small, scroll_scale)
}

/// Coarse search along the scroll `axis` only (the cross axis is pinned
/// to 0 — a single-direction scroll doesn't drift sideways). Returns the
/// best offset in *thumbnail* pixels. Biased to allow a positive sweep
/// up to ¾ of the axis (content moves opposite the scroll).
fn coarse_search_axis(p_small: &RgbaImage, n_small: &RgbaImage, axis: ScrollAxis) -> i32 {
    let dim = match axis {
        ScrollAxis::Vertical => p_small.height(),
        ScrollAxis::Horizontal => p_small.width(),
    } as i32;
    let (lo, hi) = (-dim / 4, (dim * 3) / 4);

    let mut best = 0i32;
    let mut best_score = f64::MAX;
    for d in lo..=hi {
        let (dx, dy) = axis.delta(d);
        if let Some(score) = ssd_overlap(p_small, n_small, dx, dy, 1) {
            if score < best_score {
                best_score = score;
                best = d;
            }
        }
    }
    best
}

/// Full-resolution refinement along `axis`: local search `±radius` around
/// the coarse estimate, scored on the original frames (strided). Corrects
/// the downscale quantization so the returned offset is pixel-accurate —
/// the difference between an invisible seam and a ghosted/duplicated one
/// in the stitch.
fn refine_search_axis(
    prev: &RgbaImage,
    next: &RgbaImage,
    axis: ScrollAxis,
    est: i32,
    radius: i32,
) -> i32 {
    let mut best = est;
    let mut best_score = f64::MAX;
    for d in (est - radius)..=(est + radius) {
        let (dx, dy) = axis.delta(d);
        if let Some(score) = ssd_overlap(prev, next, dx, dy, FINE_STRIDE) {
            if score < best_score {
                best_score = score;
                best = d;
            }
        }
    }
    best
}

/// Best-matching `(dx, dy)` between two same-size frames, in `next`'s
/// pixel space (how far the content translated along the scroll `axis`).
/// Two stages: a cheap coarse search on an **axis-preserving** thumbnail
/// for a ballpark, then a full-resolution refinement around it for pixel
/// accuracy. The cross axis is pinned to 0 (a single-direction scroll).
///
/// Two earlier bugs this fixes: (1) the search ran on a longest-edge
/// downscale, so a wide-short / tall-narrow custom selection lost the
/// scroll-axis detail and mis-detected; (2) the result was the coarse
/// thumbnail offset scaled back up, snapping to a multiple of the
/// downscale factor and seaming the stitch. Axis-preserving downscale
/// fixes (1); the refine pass fixes (2).
pub fn detect_offset(prev: &RgbaImage, next: &RgbaImage, axis: ScrollAxis) -> (i32, i32) {
    axis.delta(detect_offset_inner(prev, next, axis))
}

/// Shared coarse→fine core: returns the best along-axis offset (full-res
/// px). Both `detect_offset` and `detect_offset_confident` build on it.
fn detect_offset_inner(prev: &RgbaImage, next: &RgbaImage, axis: ScrollAxis) -> i32 {
    let (p_small, scroll_scale) = axis_downscale(prev, axis);
    let (n_small, _) = axis_downscale(next, axis);

    let coarse = coarse_search_axis(&p_small, &n_small, axis);

    // Lift the coarse (thumbnail) offset back to full-res pixels.
    let inv = 1.0 / scroll_scale;
    let est = (coarse as f64 * inv).round() as i32;

    // The fine window must cover the coarse quantization (±inv) + margin.
    let radius = ((inv.ceil() as i32) + REFINE_MARGIN).clamp(REFINE_MARGIN, REFINE_MAX_RADIUS);
    refine_search_axis(prev, next, axis, est, radius)
}

/// Like [`detect_offset`], but also reports whether the match is
/// **confident** — i.e. the two frames genuinely share overlapping
/// content. Confidence is the **normalized cross-correlation** of the
/// overlap at the detected offset: a real scroll aligns identical content
/// (NCC ≈ 1), whereas a step that *outran the region* (the content jumped
/// clear past the capture window, leaving zero overlap) leaves only
/// uncorrelated content there (NCC ≈ 0). NCC is used rather than a raw-SSD
/// ratio because it is invariant to brightness/contrast and is not fooled
/// by a low-overlap edge whose few-pixel SSD can spuriously beat the
/// no-shift baseline.
///
/// The panoramic worker uses this to tell "the surface scrolled, here's
/// how far" from "my wheel step was too big for this short selection" —
/// the latter is the cue to shrink the step and retry rather than commit a
/// mis-aligned frame that would collapse the stitch.
pub fn detect_offset_confident(
    prev: &RgbaImage,
    next: &RgbaImage,
    axis: ScrollAxis,
) -> (i32, i32, bool) {
    let refined = detect_offset_inner(prev, next, axis);
    let (dx, dy) = axis.delta(refined);
    let confident = ncc_overlap(prev, next, dx, dy, FINE_STRIDE)
        .is_some_and(|ncc| ncc >= OFFSET_CONFIDENCE_NCC);
    (dx, dy, confident)
}

/// Fraction of the frame's along-axis dimension that one captured step
/// must cover to count as a **deliberate** scroll. Smaller steps are
/// treated as noise (cursor drift, sub-pixel jitter, animated content)
/// and neither establish nor reverse the scroll direction.
pub const DIRECTION_MIN_FRACTION: f64 = 0.06;

/// Absolute floor (full-res px) for the deliberate-step threshold, so a
/// short region still needs a real move — not detector quantization — to
/// lock or reverse direction.
pub const DIRECTION_MIN_PX: i32 = 12;

/// The axis a scroll runs along. The recording's [`ScrollDirection`]
/// resolves to one of these, which `detect_offset` searches (pinning the
/// cross axis to 0).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScrollAxis {
    Horizontal,
    Vertical,
}

impl ScrollAxis {
    /// Build a `(dx, dy)` offset from a single along-axis magnitude,
    /// pinning the cross axis to 0.
    #[inline]
    pub fn delta(self, d: i32) -> (i32, i32) {
        match self {
            ScrollAxis::Horizontal => (d, 0),
            ScrollAxis::Vertical => (0, d),
        }
    }
}

/// User-chosen scroll direction for a Scrolling / Panoramic capture —
/// the wire enum behind the "auto-scroll direction" capture option.
/// `Down` (read a long page top-to-bottom) is the default.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ScrollDirection {
    #[default]
    Down,
    Up,
    Left,
    Right,
}

impl ScrollDirection {
    /// Axis this direction scrolls along.
    pub fn axis(self) -> ScrollAxis {
        match self {
            ScrollDirection::Down | ScrollDirection::Up => ScrollAxis::Vertical,
            ScrollDirection::Left | ScrollDirection::Right => ScrollAxis::Horizontal,
        }
    }

    /// True when the auto-scroll driver should use the **horizontal**
    /// wheel (`MOUSEEVENTF_HWHEEL`) rather than the vertical wheel.
    pub fn is_horizontal(self) -> bool {
        self.axis() == ScrollAxis::Horizontal
    }

    /// Apply this direction's sign to a wheel-delta `notches` magnitude so
    /// the content advances *this* way. The magnitude may be a whole notch
    /// count or sub-notch `WHEEL_DELTA` units (the panoramic worker passes
    /// a calibrated unit count). Vertical: down is negative (real wheel
    /// convention). Horizontal: right is positive (HWHEEL convention).
    pub fn wheel_notches(self, notches: i32) -> i32 {
        let n = notches.abs();
        match self {
            ScrollDirection::Down => -n,
            ScrollDirection::Up => n,
            ScrollDirection::Right => n,
            ScrollDirection::Left => -n,
        }
    }
}

/// A locked scroll direction: an axis plus the sign content translates
/// along it. `positive` means content moved down / right — i.e. the user
/// scrolled down / panned right.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ScrollDir {
    pub axis: ScrollAxis,
    pub positive: bool,
}

/// Deliberate-step threshold (full-res px) for `axis` on a frame of the
/// given size: a fraction of the along-axis dimension, floored.
fn deliberate_delta(frame_w: u32, frame_h: u32, axis: ScrollAxis) -> i32 {
    let dim = match axis {
        ScrollAxis::Horizontal => frame_w,
        ScrollAxis::Vertical => frame_h,
    };
    ((dim as f64 * DIRECTION_MIN_FRACTION).round() as i32).max(DIRECTION_MIN_PX)
}

/// Fold one detected step `(dx, dy)` into the locked scroll direction and
/// report whether it **reverses** that direction — the cue that the user
/// scrolled back the way they came, i.e. the capture is complete.
///
/// - Before a direction is locked, the first deliberate step locks it
///   (returned in the first tuple field).
/// - Once locked, a deliberate step *against* the lock on the **same**
///   axis returns `reversed == true`; the lock itself is preserved.
/// - Sub-threshold steps, and cross-axis steps, leave the lock unchanged
///   with `reversed == false` (conservative: only opposite-on-same-axis
///   stops, so an accidental nudge can't end a real scroll).
///
/// `panoramic` lets the horizontal axis win the dominant-axis race;
/// otherwise the step is judged on its vertical component alone.
pub fn track_direction(
    locked: Option<ScrollDir>,
    dx: i32,
    dy: i32,
    frame_w: u32,
    frame_h: u32,
    panoramic: bool,
) -> (Option<ScrollDir>, bool) {
    let axis = if panoramic && dx.abs() > dy.abs() {
        ScrollAxis::Horizontal
    } else {
        ScrollAxis::Vertical
    };
    let mag = match axis {
        ScrollAxis::Horizontal => dx,
        ScrollAxis::Vertical => dy,
    };
    if mag.abs() < deliberate_delta(frame_w, frame_h, axis) {
        return (locked, false); // noise — neither lock nor reverse
    }
    let positive = mag > 0;
    match locked {
        None => (Some(ScrollDir { axis, positive }), false),
        Some(dir) if dir.axis == axis && dir.positive != positive => (locked, true),
        Some(_) => (locked, false),
    }
}

/// Strided (every 4th pixel) mean SSD across two same-size frames.
/// Sub-millisecond; the worker calls it every tick to drop redundant
/// frames. Mismatched sizes → `f64::MAX` (treated as "very different").
pub fn frame_difference(a: &RgbaImage, b: &RgbaImage) -> f64 {
    if a.width() != b.width() || a.height() != b.height() {
        return f64::MAX;
    }
    let stride = 4;
    let mut sum = 0u64;
    let mut count = 0u64;
    for y in (0..a.height()).step_by(stride) {
        for x in (0..a.width()).step_by(stride) {
            let ap = a.get_pixel(x, y);
            let bp = b.get_pixel(x, y);
            let dr = ap[0] as i32 - bp[0] as i32;
            let dg = ap[1] as i32 - bp[1] as i32;
            let db = ap[2] as i32 - bp[2] as i32;
            sum += (dr * dr + dg * dg + db * db) as u64;
            count += 1;
        }
    }
    if count == 0 {
        0.0
    } else {
        sum as f64 / count as f64
    }
}

/// Screen-space point to aim the auto-scroll wheel at, for a canvas-local
/// `region` whose canvas `(0, 0)` sits at virtual-screen `origin`
/// `(min_x, min_y)`. Returns the region's centre in virtual-screen
/// coordinates — where the panoramic worker parks the cursor before
/// sending wheel input so the scroll lands on the captured content.
/// Pure; the I/O (SetCursorPos / SendInput) lives in `platform`.
pub fn region_scroll_anchor(
    region: &crate::overlay::Region,
    origin: (i32, i32),
) -> (i32, i32) {
    (
        origin.0 + region.x as i32 + region.width as i32 / 2,
        origin.1 + region.y as i32 + region.height as i32 / 2,
    )
}

/// Composite `frames` onto one canvas at their **cumulative** offsets
/// (`cumulative_offsets[i]` is frame `i`'s absolute position; the caller
/// accumulates them). The canvas is auto-sized to the union of frame
/// rects and white-filled for any gaps. `frames` and `cumulative_offsets`
/// must be the same non-empty length. Returns the stitched image.
pub fn stitch(frames: &[RgbaImage], cumulative_offsets: &[(i32, i32)]) -> RgbaImage {
    debug_assert_eq!(frames.len(), cumulative_offsets.len());
    if frames.is_empty() {
        return RgbaImage::new(1, 1);
    }
    let frame_w = frames[0].width() as i32;
    let frame_h = frames[0].height() as i32;

    let min_x = cumulative_offsets
        .iter()
        .map(|(x, _)| *x)
        .min()
        .unwrap_or(0);
    let min_y = cumulative_offsets
        .iter()
        .map(|(_, y)| *y)
        .min()
        .unwrap_or(0);
    let max_x = cumulative_offsets
        .iter()
        .map(|(x, _)| *x + frame_w)
        .max()
        .unwrap_or(frame_w);
    let max_y = cumulative_offsets
        .iter()
        .map(|(_, y)| *y + frame_h)
        .max()
        .unwrap_or(frame_h);
    let canvas_w = (max_x - min_x).max(1) as u32;
    let canvas_h = (max_y - min_y).max(1) as u32;

    let mut canvas = RgbaImage::from_pixel(canvas_w, canvas_h, image::Rgba([255, 255, 255, 255]));
    for (frame, &(ox, oy)) in frames.iter().zip(cumulative_offsets) {
        image::imageops::replace(&mut canvas, frame, (ox - min_x) as i64, (oy - min_y) as i64);
    }
    canvas
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each row a distinct color so a vertical shift has a clean SSD
    /// minimum; constant across x.
    fn row_pattern(w: u32, h: u32, row0: i32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |_x, y| {
            let r = (y as i32 + row0) as u32;
            image::Rgba([
                ((r * 4) % 256) as u8,
                ((r * 7) % 256) as u8,
                ((r * 3) % 256) as u8,
                255,
            ])
        })
    }

    #[test]
    fn detect_offset_finds_a_vertical_scroll() {
        // `next` is `prev` scrolled down 12 px (content shifted up): a
        // feature at prev row R sits at next row R-12 → offset (0, 12).
        let prev = row_pattern(60, 60, 0);
        let next = row_pattern(60, 60, 12);
        assert_eq!(detect_offset(&prev, &next, ScrollAxis::Vertical), (0, 12));
    }

    #[test]
    fn detect_offset_pins_cross_axis_for_vertical() {
        let prev = row_pattern(60, 60, 0);
        let next = row_pattern(60, 60, 8);
        let (dx, _dy) = detect_offset(&prev, &next, ScrollAxis::Vertical);
        assert_eq!(dx, 0, "a vertical scroll never shifts horizontally");
    }

    /// Every row a unique (r, g) so the full-res SSD has one sharp
    /// minimum at the true shift — lets us assert *exact* alignment.
    fn unique_rows(w: u32, h: u32, row0: i32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |_x, y| {
            let v = (y as i32 + row0).max(0) as u32;
            image::Rgba([(v & 0xFF) as u8, ((v >> 8) & 0xFF) as u8, 40, 255])
        })
    }

    #[test]
    fn detect_offset_refines_past_downscale_quantization() {
        // 480 px wide forces a ~3× downscale for the coarse pass, whose
        // estimate snaps to multiples of 3 px. A 17 px shift (not a
        // multiple of 3) is only recoverable if the full-res refine pass
        // runs — the old single-stage detector would have returned 15 or
        // 18, visibly seaming the stitch.
        let prev = unique_rows(480, 240, 0);
        let next = unique_rows(480, 240, 17);
        assert_eq!(detect_offset(&prev, &next, ScrollAxis::Vertical), (0, 17));
    }

    #[test]
    fn detect_offset_refines_a_range_of_shifts_exactly() {
        for shift in [5, 13, 23, 41] {
            let prev = unique_rows(400, 300, 0);
            let next = unique_rows(400, 300, shift);
            assert_eq!(
                detect_offset(&prev, &next, ScrollAxis::Vertical),
                (0, shift),
                "shift {shift} must land exactly after refinement"
            );
        }
    }

    #[test]
    fn detect_offset_handles_wide_short_selection() {
        // 720×130: a longest-edge downscale would crush the 130 px scroll
        // axis to ~29 px and mis-detect. Axis-preserving downscale keeps
        // the height, so a 14 px vertical shift lands exactly. This is the
        // "custom selection size" failure mode.
        let prev = unique_rows(720, 130, 0);
        let next = unique_rows(720, 130, 14);
        assert_eq!(detect_offset(&prev, &next, ScrollAxis::Vertical), (0, 14));
    }

    /// Each column a unique (r, g) — the horizontal analogue of
    /// `unique_rows`, for asserting exact horizontal offsets.
    fn unique_cols(w: u32, h: u32, col0: i32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, _y| {
            let v = (x as i32 + col0).max(0) as u32;
            image::Rgba([(v & 0xFF) as u8, ((v >> 8) & 0xFF) as u8, 40, 255])
        })
    }

    #[test]
    fn detect_offset_handles_horizontal_axis() {
        // A tall-short region scrolled horizontally (panoramic Left/Right):
        // search the x-axis, pin dy=0, land the shift exactly.
        let prev = unique_cols(300, 160, 0);
        let next = unique_cols(300, 160, 19);
        assert_eq!(detect_offset(&prev, &next, ScrollAxis::Horizontal), (19, 0));
    }

    /// Each row a fully-avalanched pseudo-random colour keyed on `y + row0`
    /// (a splitmix32-style mix), so non-adjacent rows are genuinely
    /// uncorrelated — the regime real screenshots live in. Unlike a plain
    /// multiplicative hash, `mix(y + c)` shares no additive structure with
    /// `mix(y)`, so a non-overlapping shift correlates near 0 (what the
    /// confidence NCC keys on); only the true shift correlates near 1.
    fn noise_rows(w: u32, h: u32, row0: i32) -> RgbaImage {
        fn mix(mut v: u32) -> u32 {
            v ^= v >> 16;
            v = v.wrapping_mul(0x7feb_352d);
            v ^= v >> 15;
            v = v.wrapping_mul(0x846c_a68b);
            v ^= v >> 16;
            v
        }
        RgbaImage::from_fn(w, h, |_x, y| {
            let v = mix((y as i32 + row0) as u32);
            image::Rgba([
                ((v >> 16) & 0xFF) as u8,
                ((v >> 8) & 0xFF) as u8,
                (v & 0xFF) as u8,
                255,
            ])
        })
    }

    #[test]
    fn detect_offset_confident_when_frames_overlap() {
        // A 14px scroll on a 130px-tall region leaves ~89% overlap: the
        // detector finds (0, 14) and is confident the frames share content.
        let prev = noise_rows(80, 130, 0);
        let next = noise_rows(80, 130, 14);
        let (dx, dy, confident) = detect_offset_confident(&prev, &next, ScrollAxis::Vertical);
        assert_eq!((dx, dy), (0, 14));
        assert!(confident, "an aligned overlap must read as confident");
    }

    #[test]
    fn detect_offset_not_confident_when_step_outran_the_region() {
        // 300px of scroll on a 130px region: the content jumped clear past
        // the window, so the frames share NO rows. The true shift is far
        // outside the search range, nothing in range beats no-shift, and
        // the match must read as NOT confident — the single-`Box-row`
        // failure's root signal.
        let prev = noise_rows(80, 130, 0);
        let next = noise_rows(80, 130, 300);
        let (_dx, _dy, confident) = detect_offset_confident(&prev, &next, ScrollAxis::Vertical);
        assert!(
            !confident,
            "a step that outran the region (zero overlap) must not be confident"
        );
    }

    #[test]
    fn calibrated_wheel_delta_targets_a_fraction_of_the_region() {
        // 0.55 * 400 = 220 px target; at 1 px/unit that's 220 units (in range).
        assert_eq!(calibrated_wheel_delta(400, 1.0), 220);
        // Short region clamps up to the responsive floor: 0.55*40=22 -> 30.
        assert_eq!(calibrated_wheel_delta(40, 1.0), AUTO_WHEEL_DELTA_MIN);
        // A fast surface (few px/unit needed) clamps down to the ceiling.
        assert_eq!(calibrated_wheel_delta(2000, 0.5), AUTO_WHEEL_DELTA_MAX);
        // Unknown calibration (0) falls back to the floor, never 0/negative.
        assert_eq!(calibrated_wheel_delta(500, 0.0), AUTO_WHEEL_DELTA_MIN);
    }

    #[test]
    fn scroll_direction_axis_and_wheel() {
        assert_eq!(ScrollDirection::Down.axis(), ScrollAxis::Vertical);
        assert_eq!(ScrollDirection::Right.axis(), ScrollAxis::Horizontal);
        assert!(!ScrollDirection::Up.is_horizontal());
        assert!(ScrollDirection::Left.is_horizontal());
        // Down/Left advance with a negative detent; Up/Right positive.
        assert_eq!(ScrollDirection::Down.wheel_notches(2), -2);
        assert_eq!(ScrollDirection::Up.wheel_notches(2), 2);
        assert_eq!(ScrollDirection::Right.wheel_notches(3), 3);
        assert_eq!(ScrollDirection::Left.wheel_notches(3), -3);
    }

    #[test]
    fn scroll_direction_serializes_kebab() {
        assert_eq!(
            serde_json::to_string(&ScrollDirection::Down).unwrap(),
            "\"down\""
        );
        assert_eq!(
            serde_json::from_str::<ScrollDirection>("\"right\"").unwrap(),
            ScrollDirection::Right
        );
        assert_eq!(ScrollDirection::default(), ScrollDirection::Down);
    }

    #[test]
    fn ssd_overlap_rejects_subthreshold_overlap() {
        let a = row_pattern(100, 100, 0);
        let b = row_pattern(100, 100, 0);
        // dy=90 leaves 10% overlap (< 12% floor) → rejected.
        assert!(ssd_overlap(&a, &b, 0, 90, 1).is_none());
        // dy=80 leaves 20% overlap → scored.
        assert!(ssd_overlap(&a, &b, 0, 80, 1).is_some());
    }

    #[test]
    fn frame_difference_zero_for_identical_positive_for_shifted() {
        let a = row_pattern(40, 40, 0);
        let b = row_pattern(40, 40, 0);
        let c = row_pattern(40, 40, 20);
        assert_eq!(frame_difference(&a, &b), 0.0);
        assert!(
            frame_difference(&a, &c) > FRAME_DEDUP_THRESHOLD,
            "a clearly-scrolled frame exceeds the dedup threshold"
        );
    }

    #[test]
    fn frame_difference_max_on_size_mismatch() {
        let a = row_pattern(40, 40, 0);
        let b = row_pattern(40, 30, 0);
        assert_eq!(frame_difference(&a, &b), f64::MAX);
    }

    #[test]
    fn stitch_sizes_canvas_and_places_frames_at_offsets() {
        let f0 = RgbaImage::from_pixel(20, 20, image::Rgba([255, 0, 0, 255]));
        let f1 = RgbaImage::from_pixel(20, 20, image::Rgba([0, 0, 255, 255]));
        let canvas = stitch(&[f0, f1], &[(0, 0), (0, 15)]);
        // Union of [0,20) and [15,35) → 20×35.
        assert_eq!((canvas.width(), canvas.height()), (20, 35));
        assert_eq!(
            canvas.get_pixel(0, 0),
            &image::Rgba([255, 0, 0, 255]),
            "frame 0 top"
        );
        assert_eq!(
            canvas.get_pixel(0, 30),
            &image::Rgba([0, 0, 255, 255]),
            "frame 1 bottom"
        );
        // The overlap (y 15..20) is the later frame composited on top.
        assert_eq!(
            canvas.get_pixel(0, 17),
            &image::Rgba([0, 0, 255, 255]),
            "later frame wins overlap"
        );
    }

    #[test]
    fn region_scroll_anchor_is_region_center_in_screen_space() {
        use crate::overlay::Region;
        // Region at canvas (100,200) sized 800×600, canvas origin at the
        // secondary-monitor virtual origin (-1920, 0).
        let r = Region {
            x: 100,
            y: 200,
            width: 800,
            height: 600,
        };
        assert_eq!(
            region_scroll_anchor(&r, (-1920, 0)),
            (-1920 + 100 + 400, 200 + 300)
        );
        // Primary-monitor origin (0,0): plain region center.
        assert_eq!(region_scroll_anchor(&r, (0, 0)), (500, 500));
    }

    #[test]
    fn stitch_handles_a_single_frame() {
        let f0 = RgbaImage::from_pixel(12, 8, image::Rgba([10, 20, 30, 255]));
        let canvas = stitch(&[f0], &[(0, 0)]);
        assert_eq!((canvas.width(), canvas.height()), (12, 8));
    }

    #[test]
    fn track_direction_locks_on_first_deliberate_down_move() {
        // 200px-tall frame → vertical threshold = max(12, 12) = 12.
        let (locked, reversed) = track_direction(None, 0, 40, 100, 200, false);
        assert!(!reversed);
        assert_eq!(
            locked,
            Some(ScrollDir {
                axis: ScrollAxis::Vertical,
                positive: true
            })
        );
    }

    #[test]
    fn track_direction_ignores_subthreshold_noise() {
        // dy below the floor → no lock, no reversal.
        let (locked, reversed) = track_direction(None, 0, 5, 100, 200, false);
        assert_eq!(locked, None);
        assert!(!reversed);
    }

    #[test]
    fn track_direction_reverses_on_opposite_move() {
        let down = Some(ScrollDir {
            axis: ScrollAxis::Vertical,
            positive: true,
        });
        let (locked, reversed) = track_direction(down, 0, -40, 100, 200, false);
        assert!(reversed, "a clear up-move after locking down is a reversal");
        assert_eq!(locked, down, "lock is preserved across a reversal");
    }

    #[test]
    fn track_direction_continues_same_direction_without_reversal() {
        let down = Some(ScrollDir {
            axis: ScrollAxis::Vertical,
            positive: true,
        });
        let (locked, reversed) = track_direction(down, 0, 60, 100, 200, false);
        assert!(!reversed);
        assert_eq!(locked, down);
    }

    #[test]
    fn track_direction_subthreshold_opposite_is_not_a_reversal() {
        // A tiny backward jitter (< floor) must not auto-stop a real scroll.
        let down = Some(ScrollDir {
            axis: ScrollAxis::Vertical,
            positive: true,
        });
        let (_locked, reversed) = track_direction(down, 0, -5, 100, 200, false);
        assert!(!reversed);
    }

    #[test]
    fn track_direction_threshold_scales_with_frame_height() {
        // 1000px-tall frame → threshold = 60px.
        let (locked, _) = track_direction(None, 0, 40, 100, 1000, false);
        assert_eq!(locked, None, "40px is noise for a 1000px region");
        let (locked, _) = track_direction(None, 0, 70, 100, 1000, false);
        assert!(locked.is_some(), "70px is deliberate for a 1000px region");
    }

    #[test]
    fn track_direction_non_panoramic_ignores_horizontal_component() {
        // detect_offset pins dx=0 when not panoramic; even a huge dx must
        // not lock a horizontal direction — judge on dy alone.
        let (locked, _) = track_direction(None, 999, 5, 100, 200, false);
        assert_eq!(
            locked, None,
            "dy=5 is noise; dx is ignored when not panoramic"
        );
    }

    #[test]
    fn track_direction_panoramic_locks_and_reverses_horizontally() {
        // Horizontal dominates → lock right, then a clear left-move reverses.
        let (right, reversed) = track_direction(None, 50, 0, 200, 100, true);
        assert!(!reversed);
        assert_eq!(
            right,
            Some(ScrollDir {
                axis: ScrollAxis::Horizontal,
                positive: true
            })
        );
        let (_locked, reversed) = track_direction(right, -50, 0, 200, 100, true);
        assert!(reversed);
    }

    #[test]
    fn track_direction_panoramic_cross_axis_is_not_a_reversal() {
        // Locked horizontal; a vertical move is a different axis — not a
        // reversal (only opposite-on-same-axis stops).
        let right = Some(ScrollDir {
            axis: ScrollAxis::Horizontal,
            positive: true,
        });
        let (locked, reversed) = track_direction(right, 0, -40, 200, 100, true);
        assert!(!reversed);
        assert_eq!(locked, right);
    }
}
