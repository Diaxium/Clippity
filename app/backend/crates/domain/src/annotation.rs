//! Studio annotations — the half of the model that has to exist twice.
//!
//! An annotation is a shape, a rectangle and a time range: it is drawn
//! over the picture while the playhead is inside its range, and burned
//! into the file on export. Most of that model lives in TypeScript,
//! deliberately, and this module is the part that cannot.
//!
//! # Why so little of it is here
//!
//! The editor established a property worth keeping: `flattenScene` is
//! the *same* code that draws the preview, so a callout on screen and a
//! callout in the exported PNG cannot disagree — there is only one
//! renderer to be wrong. Studio keeps that by rendering its boxes,
//! spotlights, arrows and text on a canvas in the webview, once per
//! interval between annotation boundaries, and handing the results down
//! as overlay bitmaps. Rust composites them; it never draws them. Text
//! and arrowheads therefore cost nothing here, and cannot drift, because
//! no second implementation of them exists.
//!
//! # Why the redactions are the exception
//!
//! A blur or a pixelation is not something painted on top. It is a
//! transform of the pixels *underneath*, so it cannot be pre-rendered
//! into an overlay by a webview that does not have the decoded frame.
//! These cross as parameters and are implemented twice — once here for
//! the export, once in TypeScript for the preview.
//!
//! That makes them the only place in the feature where the two halves
//! can drift, so both are defined as exactly reproducible **integer**
//! operations rather than as "a blur":
//!
//! - [`pixelate`] averages each block of a grid anchored at the rect's
//!   top-left corner, and fills the block with that average.
//! - [`box_blur`] is three passes of a separable box average, not a
//!   Gaussian. A Gaussian's kernel weights are floating-point and would
//!   have to match across two languages' rounding; three box passes
//!   approximate one closely enough for a redaction and are specifiable
//!   in integers.
//!
//! Both round with [`round_div`] and both clamp their sampling to the
//! rect, so the result depends only on the pixels inside it. A shared
//! fixture pins the two implementations against each other.
//!
//! # Scale, and what the preview can honestly promise
//!
//! [`Redaction::block`] and [`Redaction::radius`] are in **source
//! pixels**. The preview runs the same operation on a frame scaled to
//! the display, with the sizes scaled to match, so its blocks do not
//! land on the same grid as the export's. That is a property of showing
//! a scaled picture, not a defect: the preview shows the operation, and
//! the fixture pins the operation.

use serde::{Deserialize, Serialize};

use image::RgbaImage;

/// Passes of box average that stand in for a Gaussian blur.
///
/// Three is the usual answer and the reason is the central limit
/// theorem: repeated box convolution converges on a Gaussian, and by the
/// third pass the difference is not visible at redaction strengths.
const BLUR_PASSES: u32 = 3;

/// Smallest pixelation block that actually redacts anything.
///
/// A block of 1 is the identity, and 2 leaves text legible. Clamping
/// here rather than validating means a slider that goes too low produces
/// a weak redaction rather than a transparent one.
pub const MIN_PIXELATE_BLOCK: u32 = 3;

/// A rectangle in fractions of the frame, `0.0..=1.0`.
///
/// Normalised rather than in pixels so an annotation survives being
/// applied to a different size of the same picture — the preview draws
/// at whatever the stage is showing, the export at the source's native
/// resolution, and a trim to GIF at a third size again. Storing pixels
/// would tie a saved sidecar to the display it was authored on.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl NormRect {
    /// Resolve against a frame size, clamped to its bounds.
    ///
    /// Returns `None` for a rectangle that lands on no pixels at all —
    /// zero-sized, entirely off-frame, or built from non-finite numbers.
    /// Callers treat that as "nothing to do", which is why it is an
    /// `Option` rather than an error: a degenerate rectangle is a
    /// half-finished drag, not a failure worth abandoning an export for.
    pub fn to_pixels(self, frame_w: u32, frame_h: u32) -> Option<PixelRect> {
        if !(self.x.is_finite() && self.y.is_finite() && self.w.is_finite() && self.h.is_finite()) {
            return None;
        }
        if frame_w == 0 || frame_h == 0 {
            return None;
        }
        // Resolve the edges before clamping, so a rectangle that starts
        // off the left of the frame keeps the part of it that is on.
        let left = (self.x * frame_w as f32).floor().max(0.0) as u32;
        let top = (self.y * frame_h as f32).floor().max(0.0) as u32;
        let right = (((self.x + self.w) * frame_w as f32).ceil().max(0.0) as u32).min(frame_w);
        let bottom = (((self.y + self.h) * frame_h as f32).ceil().max(0.0) as u32).min(frame_h);

        if right <= left || bottom <= top {
            return None;
        }
        Some(PixelRect {
            x: left,
            y: top,
            w: right - left,
            h: bottom - top,
        })
    }
}

/// A rectangle resolved onto a specific frame, guaranteed to be inside
/// it and to cover at least one pixel. Only [`NormRect::to_pixels`]
/// constructs one, which is what lets the filters index without
/// bounds-checking every access.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl PixelRect {
    pub fn right(self) -> u32 {
        self.x + self.w
    }
    pub fn bottom(self) -> u32 {
        self.y + self.h
    }
}

/// How a redaction hides what is under it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum RedactionMode {
    /// Average each `block`×`block` cell into a single colour.
    Pixelate { block: u32 },
    /// [`BLUR_PASSES`] passes of a box average of the given radius.
    Blur { radius: u32 },
}

/// A pixel-transforming annotation, resolved for the export path.
///
/// Solid-fill redaction is deliberately *not* here — a filled rectangle
/// is drawn, so it travels as an overlay with everything else that is
/// drawn. Only the two transforms that need the frame's own pixels
/// appear in this enum, which is what keeps the burn-in's second
/// implementation as small as it is.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Redaction {
    pub rect: NormRect,
    #[serde(flatten)]
    pub mode: RedactionMode,
    pub start_ms: u64,
    /// Exclusive, matching the trim range's convention so two adjacent
    /// annotations tile without a frame belonging to both.
    pub end_ms: u64,
}

impl Redaction {
    /// Whether this redaction covers a moment.
    pub fn covers(&self, ms: u64) -> bool {
        ms >= self.start_ms && ms < self.end_ms
    }
}

/// One pre-rendered overlay bitmap and the span of the clip it covers.
///
/// Produced by the webview — one per interval between annotation
/// boundaries, not one per frame — and staged to a file rather than
/// carried inline, so a multi-megabyte payload never crosses IPC in a
/// single serialize.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayRef {
    /// Absolute path of the staged PNG.
    pub path: String,
    pub start_ms: u64,
    /// Exclusive, as [`Redaction::end_ms`].
    pub end_ms: u64,
}

impl OverlayRef {
    pub fn covers(&self, ms: u64) -> bool {
        ms >= self.start_ms && ms < self.end_ms
    }
}

/// The overlay covering a moment, if any.
///
/// Intervals are built by the webview and do not overlap, so the first
/// match is the only match. Linear rather than a binary search on
/// purpose: the list holds one entry per annotation boundary — single
/// digits in practice — and a scan of that is faster than the branch
/// misses of a search, besides being obviously correct.
pub fn overlay_at(overlays: &[OverlayRef], ms: u64) -> Option<&OverlayRef> {
    overlays.iter().find(|o| o.covers(ms))
}

/// Apply every redaction covering `ms` to `frame`, in order.
///
/// Order matters only where two overlap, and then the later one wins on
/// the shared pixels — the same last-writer rule the drawn annotations
/// get for free by being composited in order.
pub fn apply_redactions(frame: &mut RgbaImage, redactions: &[Redaction], ms: u64) {
    let (w, h) = frame.dimensions();
    for redaction in redactions.iter().filter(|r| r.covers(ms)) {
        let Some(rect) = redaction.rect.to_pixels(w, h) else {
            continue;
        };
        match redaction.mode {
            RedactionMode::Pixelate { block } => pixelate(frame, rect, block),
            RedactionMode::Blur { radius } => box_blur(frame, rect, radius),
        }
    }
}

/// Alpha-composite `overlay` over `frame`, source-over.
///
/// This is the whole of the burn-in for everything Studio *draws*. The
/// webview rendered those annotations to a transparent PNG with the same
/// canvas code that drew them on screen, so there is nothing left to
/// interpret here — no shapes, no fonts, no colours, just a blend.
///
/// The overlay carries **straight** (non-premultiplied) alpha, which is
/// what `canvas.toDataURL` produces. Treating it as premultiplied
/// darkens every soft edge, a mistake that looks like slightly wrong
/// antialiasing rather than like a bug.
///
/// The frame's own alpha is left at whatever it was: a decoded video
/// frame is opaque, and the output has nowhere to put transparency
/// anyway. Sizes that disagree are composited over the overlapping
/// region rather than refused — see the caller, which logs it.
pub fn composite_over(frame: &mut RgbaImage, overlay: &RgbaImage) {
    let (fw, fh) = frame.dimensions();
    let (ow, oh) = overlay.dimensions();
    let (w, h) = (fw.min(ow), fh.min(oh));

    for y in 0..h {
        for x in 0..w {
            let src = *overlay.get_pixel(x, y);
            let alpha = src[3] as u32;
            if alpha == 0 {
                continue;
            }
            let dst = frame.get_pixel_mut(x, y);
            if alpha == 255 {
                dst[0] = src[0];
                dst[1] = src[1];
                dst[2] = src[2];
                continue;
            }
            let inverse = 255 - alpha;
            for c in 0..3 {
                dst[c] = blend(src[c] as u32, alpha, dst[c] as u32, inverse);
            }
        }
    }
}

/// One channel of a source-over blend, rounded half up.
fn blend(src: u32, alpha: u32, dst: u32, inverse: u32) -> u8 {
    round_div(src * alpha + dst * inverse, 255)
}

/// Integer mean, rounding halves up.
///
/// Stated as its own function because it is the single arithmetic
/// decision the TypeScript mirror has to match. `(sum + n/2) / n` in
/// integers rounds `.5` away from zero for the non-negative values a
/// colour channel holds; anything else — truncation, or a float divide
/// then a cast — lands a channel one value off on roughly half the
/// blocks in an image, which a fixture comparison catches and a human
/// never would.
fn round_div(sum: u32, n: u32) -> u8 {
    if n == 0 {
        return 0;
    }
    ((sum + n / 2) / n) as u8
}

/// Average each block of a grid anchored at the rect's top-left, and
/// fill the block with it.
///
/// Anchored at the rect rather than at the frame's origin so a redaction
/// looks the same wherever it is dragged to — a grid tied to the frame
/// would make the block pattern shift under a rectangle being moved,
/// which reads as the redaction flickering.
///
/// Blocks at the right and bottom edges are clipped by the rect and
/// average over the smaller area, so the whole rectangle is covered.
/// Alpha is left alone: a decoded video frame is opaque, and a redaction
/// that changed transparency would be a hole rather than a cover-up.
pub fn pixelate(frame: &mut RgbaImage, rect: PixelRect, block: u32) {
    let block = block.max(MIN_PIXELATE_BLOCK);

    let mut top = rect.y;
    while top < rect.bottom() {
        let cell_h = block.min(rect.bottom() - top);
        let mut left = rect.x;
        while left < rect.right() {
            let cell_w = block.min(rect.right() - left);

            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for y in top..top + cell_h {
                for x in left..left + cell_w {
                    let px = frame.get_pixel(x, y);
                    r += px[0] as u32;
                    g += px[1] as u32;
                    b += px[2] as u32;
                }
            }
            let n = cell_w * cell_h;
            let (r, g, b) = (round_div(r, n), round_div(g, n), round_div(b, n));

            for y in top..top + cell_h {
                for x in left..left + cell_w {
                    let px = frame.get_pixel_mut(x, y);
                    px[0] = r;
                    px[1] = g;
                    px[2] = b;
                }
            }
            left += block;
        }
        top += block;
    }
}

/// [`BLUR_PASSES`] passes of a separable box average over the rect.
///
/// Works on a copy of the rect's RGB rather than in place, because a box
/// average has to read the *input* of its pass: blurring in place would
/// feed each pixel's new value into its neighbour's window and smear the
/// result along the scan direction.
///
/// Sampling clamps to the rect's edges, so the blur never reads a pixel
/// outside the rectangle the user drew. That matters for more than
/// tidiness — a blur that pulled in surrounding pixels would leak a
/// blurred trace of the redacted content into the border, and pull the
/// unredacted surroundings into the redaction.
pub fn box_blur(frame: &mut RgbaImage, rect: PixelRect, radius: u32) {
    if radius == 0 {
        return;
    }
    let (w, h) = (rect.w as usize, rect.h as usize);
    let mut buf = extract_rgb(frame, rect);

    for _ in 0..BLUR_PASSES {
        buf = box_pass(&buf, w, h, radius as usize, Axis::Horizontal);
        buf = box_pass(&buf, w, h, radius as usize, Axis::Vertical);
    }
    write_rgb(frame, rect, &buf);
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Axis {
    Horizontal,
    Vertical,
}

/// One separable box-average pass over a tightly packed RGB buffer.
fn box_pass(src: &[u8], w: usize, h: usize, radius: usize, axis: Axis) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 3];
    // The window is symmetric, so it spans 2r+1 samples — and never
    // zero, which is what makes the mean below safe to take.
    let window = (radius * 2 + 1) as u32;
    let span = if axis == Axis::Horizontal { w } else { h };

    for y in 0..h {
        for x in 0..w {
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            let centre = if axis == Axis::Horizontal { x } else { y };
            for offset in 0..window as usize {
                // Clamp to the rect: the edge sample repeats rather than
                // wrapping or reading outside.
                let at = (centre + offset)
                    .saturating_sub(radius)
                    .min(span.saturating_sub(1));
                let i = if axis == Axis::Horizontal {
                    (y * w + at) * 3
                } else {
                    (at * w + x) * 3
                };
                r += src[i] as u32;
                g += src[i + 1] as u32;
                b += src[i + 2] as u32;
            }
            let o = (y * w + x) * 3;
            out[o] = round_div(r, window);
            out[o + 1] = round_div(g, window);
            out[o + 2] = round_div(b, window);
        }
    }
    out
}

/// Copy a rect's RGB into a tightly packed buffer, dropping alpha.
fn extract_rgb(frame: &RgbaImage, rect: PixelRect) -> Vec<u8> {
    let mut buf = Vec::with_capacity((rect.w * rect.h) as usize * 3);
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            let px = frame.get_pixel(x, y);
            buf.extend_from_slice(&[px[0], px[1], px[2]]);
        }
    }
    buf
}

/// Write a packed RGB buffer back over a rect, leaving alpha as it was.
fn write_rgb(frame: &mut RgbaImage, rect: PixelRect, buf: &[u8]) {
    for row in 0..rect.h {
        for col in 0..rect.w {
            let i = ((row * rect.w + col) * 3) as usize;
            let px = frame.get_pixel_mut(rect.x + col, rect.y + row);
            px[0] = buf[i];
            px[1] = buf[i + 1];
            px[2] = buf[i + 2];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn frame(w: u32, h: u32, fill: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(fill))
    }

    fn full() -> NormRect {
        NormRect {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        }
    }

    // ---------- NormRect ----------

    #[test]
    fn a_full_rect_resolves_to_the_whole_frame() {
        let r = full().to_pixels(100, 50).expect("covers pixels");
        assert_eq!(
            r,
            PixelRect {
                x: 0,
                y: 0,
                w: 100,
                h: 50
            }
        );
    }

    #[test]
    fn a_rect_hanging_off_the_edge_keeps_the_part_that_is_on() {
        // A drag that runs past the right edge means "to the edge", the
        // same reading `validate_trim` gives an overshooting timeline.
        let r = NormRect {
            x: 0.5,
            y: 0.0,
            w: 5.0,
            h: 1.0,
        }
        .to_pixels(100, 20)
        .expect("partly on frame");
        assert_eq!(r.x, 50);
        assert_eq!(r.right(), 100);
    }

    #[test]
    fn a_rect_covering_no_pixels_resolves_to_nothing() {
        for rect in [
            NormRect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 1.0,
            },
            NormRect {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 0.0,
            },
            NormRect {
                x: 2.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
            NormRect {
                x: f32::NAN,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
        ] {
            assert_eq!(rect.to_pixels(100, 100), None, "{rect:?}");
        }
        // …and a zero-sized frame has nowhere to put even a full rect.
        assert_eq!(full().to_pixels(0, 10), None);
    }

    // ---------- round_div ----------

    #[test]
    fn the_shared_rounding_rule_rounds_halves_up() {
        // The one arithmetic decision the TypeScript mirror must match.
        assert_eq!(round_div(0, 4), 0);
        assert_eq!(round_div(10, 4), 3, "2.5 rounds up, not toward zero");
        assert_eq!(round_div(9, 2), 5, "4.5 rounds up");
        assert_eq!(round_div(7, 2), 4, "3.5 rounds up");
        assert_eq!(round_div(5, 0), 0, "an empty mean is zero, not a panic");
    }

    // ---------- pixelate ----------

    #[test]
    fn pixelation_replaces_a_block_with_its_mean() {
        let mut img = frame(4, 1, [0, 0, 0, 255]);
        img.put_pixel(0, 0, Rgba([0, 0, 0, 255]));
        img.put_pixel(1, 0, Rgba([100, 100, 100, 255]));
        img.put_pixel(2, 0, Rgba([200, 200, 200, 255]));
        img.put_pixel(3, 0, Rgba([255, 255, 255, 255]));

        pixelate(
            &mut img,
            PixelRect {
                x: 0,
                y: 0,
                w: 4,
                h: 1,
            },
            4,
        );
        // (0 + 100 + 200 + 255) / 4 = 138.75 -> 139
        for x in 0..4 {
            assert_eq!(img.get_pixel(x, 0)[0], 139, "at {x}");
        }
    }

    #[test]
    fn pixelation_leaves_everything_outside_the_rect_alone() {
        let mut img = frame(8, 8, [10, 20, 30, 255]);
        img.put_pixel(6, 6, Rgba([255, 255, 255, 255]));
        pixelate(
            &mut img,
            PixelRect {
                x: 0,
                y: 0,
                w: 4,
                h: 4,
            },
            4,
        );
        assert_eq!(*img.get_pixel(6, 6), Rgba([255, 255, 255, 255]));
    }

    #[test]
    fn a_block_running_past_the_rect_averages_what_it_covers() {
        // 5 px of content with a 4 px block: the trailing block is one
        // pixel wide and must still be written, or a stripe of the
        // redaction is left showing.
        let mut img = frame(5, 1, [0, 0, 0, 255]);
        img.put_pixel(4, 0, Rgba([255, 255, 255, 255]));
        pixelate(
            &mut img,
            PixelRect {
                x: 0,
                y: 0,
                w: 5,
                h: 1,
            },
            4,
        );
        assert_eq!(img.get_pixel(4, 0)[0], 255, "single-pixel tail block");
    }

    #[test]
    fn a_block_size_too_small_to_redact_is_raised_to_the_floor() {
        // Block 1 is the identity — a redaction that redacts nothing.
        let mut img = frame(3, 3, [0, 0, 0, 255]);
        img.put_pixel(0, 0, Rgba([255, 255, 255, 255]));
        pixelate(
            &mut img,
            PixelRect {
                x: 0,
                y: 0,
                w: 3,
                h: 3,
            },
            1,
        );
        assert_ne!(
            *img.get_pixel(0, 0),
            Rgba([255, 255, 255, 255]),
            "a block of 1 must not pass through unchanged"
        );
    }

    #[test]
    fn pixelation_preserves_alpha() {
        let mut img = frame(4, 4, [10, 10, 10, 128]);
        pixelate(
            &mut img,
            PixelRect {
                x: 0,
                y: 0,
                w: 4,
                h: 4,
            },
            4,
        );
        assert_eq!(img.get_pixel(0, 0)[3], 128);
    }

    // ---------- box_blur ----------

    #[test]
    fn a_blur_of_a_flat_region_changes_nothing() {
        // The strongest statement of correctness for an averaging
        // filter: the mean of identical values is that value, so any
        // drift here is a bug in the windowing rather than in the maths.
        let mut img = frame(16, 16, [77, 88, 99, 255]);
        box_blur(
            &mut img,
            PixelRect {
                x: 0,
                y: 0,
                w: 16,
                h: 16,
            },
            3,
        );
        for px in img.pixels() {
            assert_eq!(*px, Rgba([77, 88, 99, 255]));
        }
    }

    #[test]
    fn a_blur_spreads_an_isolated_pixel_into_its_neighbours() {
        let mut img = frame(9, 9, [0, 0, 0, 255]);
        img.put_pixel(4, 4, Rgba([255, 255, 255, 255]));
        box_blur(
            &mut img,
            PixelRect {
                x: 0,
                y: 0,
                w: 9,
                h: 9,
            },
            1,
        );
        assert!(img.get_pixel(4, 4)[0] < 255, "the centre gave light away");
        assert!(img.get_pixel(3, 4)[0] > 0, "a neighbour received some");
    }

    #[test]
    fn a_blur_reads_no_pixel_from_outside_its_rect() {
        // Otherwise the redaction leaks: a blurred trace of the hidden
        // content bleeds into the border, and the surroundings bleed in.
        let mut img = frame(12, 12, [255, 255, 255, 255]);
        for y in 4..8 {
            for x in 4..8 {
                img.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        box_blur(
            &mut img,
            PixelRect {
                x: 4,
                y: 4,
                w: 4,
                h: 4,
            },
            2,
        );
        for y in 4..8 {
            for x in 4..8 {
                assert_eq!(
                    img.get_pixel(x, y)[0],
                    0,
                    "white from outside reached ({x}, {y})"
                );
            }
        }
    }

    #[test]
    fn a_zero_radius_blur_is_a_no_op() {
        let mut img = frame(4, 4, [1, 2, 3, 255]);
        img.put_pixel(0, 0, Rgba([200, 200, 200, 255]));
        let before = img.clone();
        box_blur(
            &mut img,
            PixelRect {
                x: 0,
                y: 0,
                w: 4,
                h: 4,
            },
            0,
        );
        assert_eq!(img, before);
    }

    #[test]
    fn a_blur_preserves_alpha() {
        let mut img = frame(8, 8, [10, 10, 10, 64]);
        img.put_pixel(4, 4, Rgba([255, 255, 255, 64]));
        box_blur(
            &mut img,
            PixelRect {
                x: 0,
                y: 0,
                w: 8,
                h: 8,
            },
            2,
        );
        for px in img.pixels() {
            assert_eq!(px[3], 64);
        }
    }

    // ---------- coverage + dispatch ----------

    #[test]
    fn a_range_includes_its_start_and_excludes_its_end() {
        // The same half-open convention the trim range uses, so two
        // adjacent annotations tile without a frame belonging to both.
        let r = Redaction {
            rect: full(),
            mode: RedactionMode::Pixelate { block: 8 },
            start_ms: 1_000,
            end_ms: 2_000,
        };
        assert!(!r.covers(999));
        assert!(r.covers(1_000));
        assert!(r.covers(1_999));
        assert!(!r.covers(2_000));
    }

    #[test]
    fn only_the_redactions_covering_the_moment_are_applied() {
        let mut img = frame(8, 8, [255, 255, 255, 255]);
        img.put_pixel(0, 0, Rgba([0, 0, 0, 255]));
        let redactions = vec![Redaction {
            rect: full(),
            mode: RedactionMode::Pixelate { block: 8 },
            start_ms: 5_000,
            end_ms: 6_000,
        }];

        apply_redactions(&mut img, &redactions, 1_000);
        assert_eq!(img.get_pixel(0, 0)[0], 0, "outside the range, untouched");

        apply_redactions(&mut img, &redactions, 5_500);
        assert_ne!(img.get_pixel(0, 0)[0], 0, "inside the range, applied");
    }

    #[test]
    fn a_degenerate_rect_is_skipped_rather_than_failing_the_export() {
        let mut img = frame(8, 8, [1, 2, 3, 255]);
        let before = img.clone();
        apply_redactions(
            &mut img,
            &[Redaction {
                rect: NormRect {
                    x: 0.0,
                    y: 0.0,
                    w: 0.0,
                    h: 0.0,
                },
                mode: RedactionMode::Blur { radius: 4 },
                start_ms: 0,
                end_ms: 1_000,
            }],
            10,
        );
        assert_eq!(img, before);
    }

    // ---------- the cross-language fixture ----------
    //
    // These two filters are the only code in the annotation feature that
    // exists twice — once here for the export, once in TypeScript for
    // the preview (`studio/lib/redact.ts`). Everything else is drawn by
    // one canvas renderer and cannot disagree with itself.
    //
    // So the fixture is the thing keeping them equal. Rust is the
    // reference because Rust is what writes the exported file; the
    // TypeScript test reads the same JSON and asserts the same bytes.
    // Regenerate with:
    //
    //     cargo test -p clippity-domain regenerate_the_shared -- --ignored
    //
    // and expect `redact.test.ts` to fail until the preview is changed
    // to match — that failure is the mechanism working, not a problem.

    /// Where both languages look for the fixture.
    fn fixture_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../shared/fixtures/redaction-fixture.json")
    }

    /// Deterministic test frame: flat blocks, a hard edge and some
    /// high-frequency noise, so pixelation has something to average and
    /// the blur has something to spread.
    fn fixture_input(w: u32, h: u32) -> RgbaImage {
        let mut img = RgbaImage::new(w, h);
        // A tiny LCG — reproducible, and its constants do not matter
        // because the bytes it produces are checked into the fixture.
        let mut seed: u32 = 0x1234_5678;
        for y in 0..h {
            for x in 0..w {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = (seed >> 24) as u8;
                let px = if x < w / 3 {
                    [255, 32, 32, 255]
                } else if x < 2 * w / 3 {
                    [16, 200, 96, 255]
                } else {
                    [noise, noise / 2, 255 - noise, 255]
                };
                img.put_pixel(x, y, Rgba(px));
            }
        }
        img
    }

    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The cases both sides run. One list, so neither can quietly test
    /// something the other does not.
    fn fixture_cases() -> Vec<(&'static str, PixelRect, RedactionMode)> {
        vec![
            (
                // Block does not divide the rect: exercises the clipped
                // tail blocks at the right and bottom edges.
                "pixelate-5-full",
                PixelRect {
                    x: 0,
                    y: 0,
                    w: 24,
                    h: 16,
                },
                RedactionMode::Pixelate { block: 5 },
            ),
            (
                // Offset rect: exercises the grid being anchored at the
                // rect rather than at the frame's origin.
                "pixelate-4-offset",
                PixelRect {
                    x: 5,
                    y: 3,
                    w: 13,
                    h: 9,
                },
                RedactionMode::Pixelate { block: 4 },
            ),
            (
                "blur-2-full",
                PixelRect {
                    x: 0,
                    y: 0,
                    w: 24,
                    h: 16,
                },
                RedactionMode::Blur { radius: 2 },
            ),
            (
                // Offset rect: exercises the edge clamping that stops a
                // blur reading pixels from outside the redaction.
                "blur-3-offset",
                PixelRect {
                    x: 6,
                    y: 2,
                    w: 12,
                    h: 11,
                },
                RedactionMode::Blur { radius: 3 },
            ),
        ]
    }

    fn apply_case(input: &RgbaImage, rect: PixelRect, mode: RedactionMode) -> RgbaImage {
        let mut img = input.clone();
        match mode {
            RedactionMode::Pixelate { block } => pixelate(&mut img, rect, block),
            RedactionMode::Blur { radius } => box_blur(&mut img, rect, radius),
        }
        img
    }

    #[test]
    #[ignore = "regenerates the checked-in fixture"]
    fn regenerate_the_shared_redaction_fixture() {
        const W: u32 = 24;
        const H: u32 = 16;
        let input = fixture_input(W, H);

        let cases: Vec<String> = fixture_cases()
            .into_iter()
            .map(|(name, rect, mode)| {
                let (op, size) = match mode {
                    RedactionMode::Pixelate { block } => ("pixelate", block),
                    RedactionMode::Blur { radius } => ("blur", radius),
                };
                let out = apply_case(&input, rect, mode);
                format!(
                    r#"    {{
      "name": "{name}",
      "op": "{op}",
      "size": {size},
      "rect": {{ "x": {}, "y": {}, "w": {}, "h": {} }},
      "expectedHex": "{}"
    }}"#,
                    rect.x,
                    rect.y,
                    rect.w,
                    rect.h,
                    to_hex(out.as_raw())
                )
            })
            .collect();

        let json = format!(
            r#"{{
  "_comment": [
    "Generated by clippity-domain's regenerate_the_shared_redaction_fixture test.",
    "Read by BOTH app/backend/crates/domain/src/annotation.rs and",
    "app/frontend/src/features/studio/lib/redact.test.ts, which is the point:",
    "the redaction filters are the only part of Studio's annotations that is",
    "implemented twice, and this file is what stops the two from drifting.",
    "Do not hand-edit. Regenerate with:",
    "  cargo test -p clippity-domain regenerate_the_shared -- --ignored"
  ],
  "width": {W},
  "height": {H},
  "inputHex": "{}",
  "cases": [
{}
  ]
}}
"#,
            to_hex(input.as_raw()),
            cases.join(",\n")
        );

        let path = fixture_path();
        std::fs::create_dir_all(path.parent().expect("has a parent")).expect("fixture dir");
        std::fs::write(&path, json).expect("write fixture");
        println!("wrote {}", path.display());
    }

    #[test]
    fn the_filters_still_produce_what_the_shared_fixture_records() {
        // The Rust half of the cross-language pin. If this fails, the
        // export changed; if only the TypeScript half fails, the preview
        // did. Either way the two no longer agree, which is exactly the
        // thing no amount of reading the code reliably catches.
        let text = std::fs::read_to_string(fixture_path()).expect(
            "the shared redaction fixture is missing — regenerate it with \
             `cargo test -p clippity-domain regenerate_the_shared -- --ignored`",
        );
        let fixture: serde_json::Value = serde_json::from_str(&text).expect("fixture parses");

        let w = fixture["width"].as_u64().expect("width") as u32;
        let h = fixture["height"].as_u64().expect("height") as u32;
        let input = fixture_input(w, h);
        assert_eq!(
            to_hex(input.as_raw()),
            fixture["inputHex"].as_str().expect("inputHex"),
            "the fixture's input no longer matches the generator"
        );

        let recorded = fixture["cases"].as_array().expect("cases");
        let cases = fixture_cases();
        assert_eq!(recorded.len(), cases.len(), "case count drifted");

        for ((name, rect, mode), entry) in cases.into_iter().zip(recorded) {
            assert_eq!(entry["name"].as_str(), Some(name), "case order drifted");
            let out = apply_case(&input, rect, mode);
            assert_eq!(
                to_hex(out.as_raw()),
                entry["expectedHex"].as_str().expect("expectedHex"),
                "case {name} no longer matches the fixture"
            );
        }
    }

    // ---------- wire shape ----------

    #[test]
    fn a_redaction_serializes_flat_with_its_mode_as_a_tag() {
        // Pins the shape the TypeScript contract mirrors. The mode is an
        // internally-tagged enum flattened into the struct, which is
        // easy to change by accident and impossible to notice from this
        // side — the symptom is a redaction that silently stops
        // deserializing and so stops being applied.
        let json = serde_json::to_value(Redaction {
            // Binary fractions, so widening f32 to JSON's f64 is exact
            // and the assertion is about the shape rather than about
            // floating-point representation.
            rect: NormRect {
                x: 0.25,
                y: 0.5,
                w: 0.125,
                h: 0.75,
            },
            mode: RedactionMode::Pixelate { block: 12 },
            start_ms: 1_000,
            end_ms: 2_000,
        })
        .expect("serializes");

        assert_eq!(json["mode"], "pixelate");
        assert_eq!(json["block"], 12);
        assert_eq!(json["startMs"], 1_000);
        assert_eq!(json["endMs"], 2_000);
        assert_eq!(json["rect"]["w"], 0.125);

        let blur = serde_json::to_value(Redaction {
            rect: full(),
            mode: RedactionMode::Blur { radius: 7 },
            start_ms: 0,
            end_ms: 1,
        })
        .expect("serializes");
        assert_eq!(blur["mode"], "blur");
        assert_eq!(blur["radius"], 7);
    }

    #[test]
    fn a_redaction_round_trips_through_json() {
        for mode in [
            RedactionMode::Pixelate { block: 12 },
            RedactionMode::Blur { radius: 7 },
        ] {
            let original = Redaction {
                rect: NormRect {
                    x: 0.25,
                    y: 0.5,
                    w: 0.1,
                    h: 0.2,
                },
                mode,
                start_ms: 1_000,
                end_ms: 2_000,
            };
            let text = serde_json::to_string(&original).expect("serializes");
            let back: Redaction = serde_json::from_str(&text).expect("deserializes");
            assert_eq!(back, original);
        }
    }

    #[test]
    fn an_overlay_ref_uses_camel_case_on_the_wire() {
        let json = serde_json::to_value(OverlayRef {
            path: "C:/tmp/a.png".into(),
            start_ms: 5,
            end_ms: 9,
        })
        .expect("serializes");
        assert_eq!(json["path"], "C:/tmp/a.png");
        assert_eq!(json["startMs"], 5);
        assert_eq!(json["endMs"], 9);
    }

    // ---------- compositing ----------

    #[test]
    fn a_transparent_overlay_changes_nothing() {
        let mut img = frame(4, 4, [10, 20, 30, 255]);
        let before = img.clone();
        composite_over(&mut img, &frame(4, 4, [255, 0, 0, 0]));
        assert_eq!(img, before);
    }

    #[test]
    fn an_opaque_overlay_replaces_the_frame() {
        let mut img = frame(4, 4, [10, 20, 30, 255]);
        composite_over(&mut img, &frame(4, 4, [200, 100, 50, 255]));
        assert_eq!(*img.get_pixel(0, 0), Rgba([200, 100, 50, 255]));
    }

    #[test]
    fn a_half_transparent_overlay_lands_halfway() {
        // Straight alpha, not premultiplied: 128/255 of pure white over
        // black is mid-grey. Reading it as premultiplied would darken
        // every soft edge, which looks like bad antialiasing rather than
        // like the arithmetic being wrong.
        let mut img = frame(2, 2, [0, 0, 0, 255]);
        composite_over(&mut img, &frame(2, 2, [255, 255, 255, 128]));
        assert_eq!(img.get_pixel(0, 0)[0], 128);
    }

    #[test]
    fn compositing_leaves_the_frames_own_alpha_alone() {
        let mut img = frame(2, 2, [0, 0, 0, 255]);
        composite_over(&mut img, &frame(2, 2, [255, 255, 255, 128]));
        assert_eq!(img.get_pixel(0, 0)[3], 255);
    }

    #[test]
    fn a_mismatched_overlay_composites_over_what_overlaps() {
        // Refusing would fail an export over an off-by-one in a size the
        // user never chose; the caller logs the mismatch instead.
        let mut img = frame(4, 4, [0, 0, 0, 255]);
        composite_over(&mut img, &frame(2, 2, [255, 255, 255, 255]));
        assert_eq!(img.get_pixel(0, 0)[0], 255, "inside the overlay");
        assert_eq!(img.get_pixel(3, 3)[0], 0, "beyond it, untouched");
    }

    // ---------- overlay lookup ----------

    #[test]
    fn the_overlay_for_a_moment_is_the_interval_containing_it() {
        let overlays = vec![
            OverlayRef {
                path: "a.png".into(),
                start_ms: 0,
                end_ms: 1_000,
            },
            OverlayRef {
                path: "b.png".into(),
                start_ms: 1_000,
                end_ms: 2_000,
            },
        ];
        assert_eq!(overlay_at(&overlays, 0).unwrap().path, "a.png");
        assert_eq!(overlay_at(&overlays, 999).unwrap().path, "a.png");
        assert_eq!(overlay_at(&overlays, 1_000).unwrap().path, "b.png");
        assert!(overlay_at(&overlays, 2_000).is_none(), "past the last");
        assert!(overlay_at(&[], 0).is_none(), "no annotations at all");
    }
}
