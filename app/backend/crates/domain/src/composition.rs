//! Recorder sources — the things composited over a captured frame, and
//! the blend that puts them there (ADR 0033).
//!
//! A recording's geometry is whatever the user pointed at: a region, a
//! window, a monitor. Sources are drawn **into** that rectangle at a
//! normalized position; they do not build a canvas of their own. That is
//! the difference between a capture tool that can put a webcam in the
//! corner and a compositor that happens to capture — the second one has
//! to answer "what size is the canvas" before anything can be recorded,
//! and turns the region the user dragged into content to be letterboxed
//! inside something else.
//!
//! **Cost is bounded by overlay area, not canvas area.** A 320×240
//! picture-in-picture is ~77 k pixels blended into a frame of 7.4 M. The
//! per-frame full-canvas pass that `SinkFrame` exists to avoid is not
//! reintroduced here.
//!
//! No I/O, no platform code: opening a camera and reading an image file
//! belong to `platform` and `services`. What lives here is the shape of a
//! source list and the arithmetic of putting one pixel over another.

use serde::{Deserialize, Serialize};

use crate::annotation::NormRect;
use crate::pixels::PixelOrder;

/// Most sources one recording may carry.
///
/// Not a technical limit — the blend is linear in total overlay area, so
/// ten small sources cost what one large one does. It is a bound on
/// *nonsense*: a list this long is a corrupted settings file or a UI bug,
/// and refusing to iterate it forever is cheaper than discovering why.
pub const MAX_SOURCES: usize = 8;

/// Fully opaque, as a percentage — the default for every source.
pub const OPACITY_PCT_DEFAULT: u16 = 100;

/// Percentages rather than a float, for the reasons
/// `recorder::clamp_gain_pct` gives: it is the unit the slider shows, it
/// round-trips through JSON exactly, and there is no NaN to defend
/// against.
pub fn clamp_opacity_pct(requested: u16) -> u16 {
    requested.min(100)
}

/// What a source draws.
///
/// Deliberately small. A webcam and a still image are the two things
/// people actually put over a screen recording, and both are "some
/// pixels, positioned" — which is what makes one blend serve both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SourceKind {
    /// A video-capture device. `None` follows the OS default, matching
    /// how `recorder::AudioSelection` pins its endpoints.
    #[serde(rename_all = "camelCase")]
    Webcam { device_id: Option<String> },
    /// A still image on disk — a logo, a watermark, a frame.
    #[serde(rename_all = "camelCase")]
    Image { path: String },
}

/// One thing composited over the recording, and where.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    #[serde(flatten)]
    pub kind: SourceKind,
    /// Position and size as a fraction of the recorded frame.
    ///
    /// Normalized so the same source lands correctly on a different
    /// region or a different monitor — which is what lets a recording
    /// preset carry a source list at all.
    pub rect: NormRect,
    #[serde(default = "default_opacity_pct")]
    pub opacity_pct: u16,
    /// Skipped without being forgotten. A disabled source keeps its
    /// position, so turning a webcam off for one recording does not cost
    /// the user the corner they placed it in.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_opacity_pct() -> u16 {
    OPACITY_PCT_DEFAULT
}

fn default_enabled() -> bool {
    true
}

impl Source {
    /// This source with its loosely-stored fields pulled into range.
    pub fn clamped(mut self) -> Self {
        self.opacity_pct = clamp_opacity_pct(self.opacity_pct);
        self
    }

    /// Whether this source would draw anything at all.
    pub fn draws(&self) -> bool {
        self.enabled && self.opacity_pct > 0
    }
}

/// Normalise a whole source list: drop the excess, clamp what remains.
///
/// **Order is preserved and meaningful** — later sources draw over
/// earlier ones, so two overlapping sources have a defined result rather
/// than one that depends on how the list happened to be iterated.
pub fn clamp_sources(sources: Vec<Source>) -> Vec<Source> {
    sources
        .into_iter()
        .take(MAX_SOURCES)
        .map(Source::clamped)
        .collect()
}

/// A source's pixels, already in the destination's channel order.
///
/// **Order is resolved when the source is opened, not per frame** — the
/// same argument `SinkFrame` makes for the encoder path, one layer up. A
/// webcam delivering BGRA into a BGRA capture then costs nothing at all,
/// and one that disagrees pays for the swap once per delivered camera
/// frame rather than once per recorded frame.
#[derive(Debug, Clone, Copy)]
pub struct SourceFrame<'a> {
    /// Tightly packed, `width * height * 4` bytes, top-down.
    pub pixels: &'a [u8],
    pub width: u32,
    pub height: u32,
}

impl SourceFrame<'_> {
    pub fn is_well_formed(&self) -> bool {
        self.pixels.len() == self.width as usize * self.height as usize * 4
    }
}

/// The destination rectangle a source occupies in a frame of
/// `frame_w × frame_h`, or `None` when it covers no pixels.
///
/// Clamped to the frame, so a source dragged half off the edge draws the
/// half that is on it rather than being refused or wrapping.
pub fn placement(source: &Source, frame_w: u32, frame_h: u32) -> Option<Placement> {
    if !source.draws() {
        return None;
    }
    let r = source.rect.to_pixels(frame_w, frame_h)?;
    Some(Placement {
        x: r.x,
        y: r.y,
        width: r.w,
        height: r.h,
    })
}

/// Where a source lands, in whole pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Placement {
    /// Bytes this placement occupies in a frame of `frame_w` — the size
    /// of the backdrop that has to be kept for it.
    pub fn backdrop_len(&self, _frame_w: u32) -> usize {
        self.width as usize * self.height as usize * 4
    }
}

/// Copy the pixels a placement covers out of `frame` into `backdrop`.
///
/// **Why a backdrop exists at all:** the recorder re-writes a *held*
/// frame in place every `MAX_HELD_MS` while the screen is motionless
/// (ADR 0031). A source blended once and left would freeze exactly when
/// it matters most — the face is the part still moving when the screen is
/// not — and blending a semi-transparent source over its own previous
/// output compounds, darkening it on every re-write until it smears.
///
/// Restoring the covered pixels before each blend makes the blend
/// idempotent with respect to the capture underneath. The backdrop is the
/// size of the overlay, so this stays bounded the same way the blend is.
pub fn save_backdrop(
    frame: &[u8],
    frame_w: u32,
    place: &Placement,
    backdrop: &mut Vec<u8>,
) -> bool {
    backdrop.clear();
    let stride = frame_w as usize * 4;
    let row_bytes = place.width as usize * 4;
    for row in 0..place.height {
        let start = (place.y + row) as usize * stride + place.x as usize * 4;
        let Some(slice) = frame.get(start..start + row_bytes) else {
            backdrop.clear();
            return false;
        };
        backdrop.extend_from_slice(slice);
    }
    true
}

/// Put a previously saved backdrop back, undoing the last blend.
pub fn restore_backdrop(
    frame: &mut [u8],
    frame_w: u32,
    place: &Placement,
    backdrop: &[u8],
) -> bool {
    let stride = frame_w as usize * 4;
    let row_bytes = place.width as usize * 4;
    if backdrop.len() != row_bytes * place.height as usize {
        return false;
    }
    for row in 0..place.height {
        let start = (place.y + row) as usize * stride + place.x as usize * 4;
        let Some(dst) = frame.get_mut(start..start + row_bytes) else {
            return false;
        };
        let from = row as usize * row_bytes;
        dst.copy_from_slice(&backdrop[from..from + row_bytes]);
    }
    true
}

/// Alpha-composite `src` over the `place` rectangle of `frame`.
///
/// Nearest-neighbour sampled: the source is whatever size the camera or
/// the file gave, the destination is where the user dragged it, and they
/// will rarely match. Nearest rather than bilinear because this runs
/// inside a frame budget and a webcam thumbnail is not a place anyone
/// looks for resampling quality — the same trade `gif_sink` makes with
/// its encoder speed.
///
/// `opacity_pct` scales the source's own alpha, so a source with
/// transparent corners keeps them at any opacity.
///
/// Both buffers must be in the **same** channel order; that is resolved
/// when the source is opened (see [`SourceFrame`]). Green and alpha sit
/// at the same indices in both orders and red/blue are symmetric under
/// the blend, so this needs no [`PixelOrder`] itself — which is asserted
/// by `a_matched_order_blend_is_order_agnostic`.
pub fn blend(
    frame: &mut [u8],
    frame_w: u32,
    frame_h: u32,
    place: &Placement,
    src: SourceFrame<'_>,
    opacity_pct: u16,
) -> bool {
    if !src.is_well_formed() || src.width == 0 || src.height == 0 {
        return false;
    }
    if place.width == 0 || place.height == 0 {
        return false;
    }
    if place.x + place.width > frame_w || place.y + place.height > frame_h {
        return false;
    }
    let opacity = clamp_opacity_pct(opacity_pct);
    if opacity == 0 {
        return true;
    }

    let stride = frame_w as usize * 4;
    let src_stride = src.width as usize * 4;

    for row in 0..place.height {
        // Nearest-neighbour: which source row/column this destination
        // pixel reads from. Computed in u64 so a large placement can't
        // overflow the multiply before the divide.
        let sy = (row as u64 * src.height as u64 / place.height as u64) as usize;
        let dst_row = (place.y + row) as usize * stride + place.x as usize * 4;
        let src_row = sy * src_stride;

        for col in 0..place.width {
            let sx = (col as u64 * src.width as u64 / place.width as u64) as usize;
            let s = src_row + sx * 4;
            let d = dst_row + col as usize * 4;

            let Some(sp) = src.pixels.get(s..s + 4) else {
                return false;
            };
            let Some(dp) = frame.get_mut(d..d + 4) else {
                return false;
            };

            // Source alpha scaled by the user's opacity, 0..=255.
            let a = (sp[3] as u32 * opacity as u32) / 100;
            if a == 0 {
                continue;
            }
            if a >= 255 {
                dp[0] = sp[0];
                dp[1] = sp[1];
                dp[2] = sp[2];
                continue;
            }
            // Standard source-over on straight (non-premultiplied)
            // alpha. The +127 rounds to nearest instead of truncating,
            // which is what stops a long chain of blends drifting dark.
            for c in 0..3 {
                let blended = sp[c] as u32 * a + dp[c] as u32 * (255 - a);
                dp[c] = ((blended + 127) / 255) as u8;
            }
            // Alpha is left alone: the capture is opaque and the file
            // has no alpha channel, so writing one would only be a lie
            // the encoder ignores.
        }
    }
    true
}

/// Convert a source's pixels into `want` order, in place.
///
/// Called once when a source frame is delivered, not per recorded frame —
/// a 30 fps camera into a 60 fps recording pays half as often as a
/// per-frame swap would, and a camera whose order already matches pays
/// nothing.
pub fn align_order(pixels: &mut [u8], have: PixelOrder, want: PixelOrder) {
    if have != want {
        crate::pixels::swap_red_blue(pixels);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, px: [u8; 4]) -> Vec<u8> {
        px.iter()
            .copied()
            .cycle()
            .take(width as usize * height as usize * 4)
            .collect()
    }

    fn source(rect: NormRect) -> Source {
        Source {
            kind: SourceKind::Webcam { device_id: None },
            rect,
            opacity_pct: OPACITY_PCT_DEFAULT,
            enabled: true,
        }
    }

    fn full_rect() -> NormRect {
        NormRect {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        }
    }

    // ---------- shape ----------

    #[test]
    fn a_source_list_is_clamped_and_capped() {
        let many: Vec<Source> = (0..20)
            .map(|_| Source {
                opacity_pct: 900,
                ..source(full_rect())
            })
            .collect();
        let out = clamp_sources(many);
        assert_eq!(out.len(), MAX_SOURCES);
        assert!(out.iter().all(|s| s.opacity_pct == 100));
    }

    #[test]
    fn a_disabled_source_keeps_its_position() {
        // Turning a webcam off for one recording must not cost the user
        // the corner they placed it in.
        let s = Source {
            enabled: false,
            ..source(full_rect())
        };
        assert!(!s.draws());
        assert_eq!(s.rect, full_rect());
        assert!(placement(&s, 100, 100).is_none());
    }

    #[test]
    fn a_fully_transparent_source_draws_nothing() {
        let s = Source {
            opacity_pct: 0,
            ..source(full_rect())
        };
        assert!(!s.draws());
    }

    #[test]
    fn a_source_round_trips_with_its_kind_flattened() {
        let s = source(full_rect());
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"kind\":\"webcam\""), "{json}");
        assert!(json.contains("\"opacityPct\""), "{json}");
        let back: Source = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn a_source_without_the_optional_fields_defaults_them() {
        let s: Source = serde_json::from_str(
            r#"{"kind":"image","path":"C:\\logo.png","rect":{"x":0,"y":0,"w":0.2,"h":0.2}}"#,
        )
        .unwrap();
        assert_eq!(s.opacity_pct, OPACITY_PCT_DEFAULT);
        assert!(s.enabled);
    }

    // ---------- blending ----------

    #[test]
    fn an_opaque_source_replaces_what_it_covers() {
        let mut frame = solid(4, 4, [10, 20, 30, 255]);
        let src = solid(2, 2, [200, 100, 50, 255]);
        let place = Placement {
            x: 1,
            y: 1,
            width: 2,
            height: 2,
        };
        assert!(blend(
            &mut frame,
            4,
            4,
            &place,
            SourceFrame {
                pixels: &src,
                width: 2,
                height: 2
            },
            100
        ));
        // Inside the placement: row 1, column 1, of a 4-wide frame.
        let inside = (4 + 1) * 4;
        assert_eq!(&frame[inside..inside + 3], &[200, 100, 50]);
        // Outside is untouched — the bound that makes this affordable.
        assert_eq!(&frame[0..3], &[10, 20, 30]);
    }

    #[test]
    fn half_opacity_lands_halfway() {
        let mut frame = solid(2, 2, [0, 0, 0, 255]);
        let src = solid(2, 2, [255, 255, 255, 255]);
        let place = Placement {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
        };
        blend(
            &mut frame,
            2,
            2,
            &place,
            SourceFrame {
                pixels: &src,
                width: 2,
                height: 2,
            },
            50,
        );
        // 50% of 255 is 127 (integer), blended over black.
        assert!(
            (frame[0] as i32 - 127).abs() <= 1,
            "got {} for a half-opacity white over black",
            frame[0]
        );
    }

    #[test]
    fn a_transparent_source_pixel_leaves_the_capture_alone() {
        // A logo with transparent corners keeps them at any opacity.
        let mut frame = solid(2, 2, [10, 20, 30, 255]);
        let src = solid(2, 2, [255, 255, 255, 0]);
        let place = Placement {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
        };
        blend(
            &mut frame,
            2,
            2,
            &place,
            SourceFrame {
                pixels: &src,
                width: 2,
                height: 2,
            },
            100,
        );
        assert_eq!(&frame[0..3], &[10, 20, 30]);
    }

    #[test]
    fn a_matched_order_blend_is_order_agnostic() {
        // The claim in `blend`'s docs: with both buffers in the same
        // order, red and blue are symmetric, so the result is the same
        // bytes whichever order those bytes happen to mean.
        let place = Placement {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
        };
        let run = |frame_px: [u8; 4], src_px: [u8; 4]| {
            let mut frame = solid(2, 2, frame_px);
            let src = solid(2, 2, src_px);
            blend(
                &mut frame,
                2,
                2,
                &place,
                SourceFrame {
                    pixels: &src,
                    width: 2,
                    height: 2,
                },
                60,
            );
            frame
        };
        let rgba = run([10, 20, 30, 255], [200, 100, 50, 255]);
        // Same pixels, both expressed in the other order.
        let bgra = run([30, 20, 10, 255], [50, 100, 200, 255]);
        assert_eq!(rgba[0], bgra[2]);
        assert_eq!(rgba[1], bgra[1]);
        assert_eq!(rgba[2], bgra[0]);
    }

    #[test]
    fn a_source_smaller_than_its_placement_is_sampled_up() {
        let mut frame = solid(4, 4, [0, 0, 0, 255]);
        let src = solid(1, 1, [90, 90, 90, 255]);
        let place = Placement {
            x: 0,
            y: 0,
            width: 4,
            height: 4,
        };
        assert!(blend(
            &mut frame,
            4,
            4,
            &place,
            SourceFrame {
                pixels: &src,
                width: 1,
                height: 1
            },
            100
        ));
        // Every covered pixel reads the one source pixel.
        assert!(frame.chunks(4).all(|p| p[0] == 90));
    }

    #[test]
    fn a_blend_off_the_frame_is_refused_rather_than_wrapping() {
        // Reading past the row would corrupt the next line rather than
        // failing, which is the bug this guards.
        let mut frame = solid(4, 4, [0, 0, 0, 255]);
        let src = solid(2, 2, [1, 2, 3, 255]);
        let place = Placement {
            x: 3,
            y: 3,
            width: 2,
            height: 2,
        };
        assert!(!blend(
            &mut frame,
            4,
            4,
            &place,
            SourceFrame {
                pixels: &src,
                width: 2,
                height: 2
            },
            100
        ));
    }

    #[test]
    fn a_malformed_source_frame_is_refused() {
        let mut frame = solid(4, 4, [0, 0, 0, 255]);
        let place = Placement {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
        };
        assert!(!blend(
            &mut frame,
            4,
            4,
            &place,
            SourceFrame {
                pixels: &[1, 2, 3],
                width: 2,
                height: 2
            },
            100
        ));
    }

    // ---------- the held-frame guarantee ----------

    #[test]
    fn restoring_the_backdrop_makes_repeated_blends_idempotent() {
        // The reason backdrops exist. A held frame is re-written every
        // MAX_HELD_MS; without a restore, a semi-transparent source
        // blended over its own output darkens on every pass until it
        // smears.
        let place = Placement {
            x: 1,
            y: 1,
            width: 2,
            height: 2,
        };
        let src = solid(2, 2, [255, 255, 255, 255]);
        let frame_src = SourceFrame {
            pixels: &src,
            width: 2,
            height: 2,
        };

        let mut frame = solid(4, 4, [0, 0, 0, 255]);
        let mut backdrop = Vec::new();
        assert!(save_backdrop(&frame, 4, &place, &mut backdrop));
        blend(&mut frame, 4, 4, &place, frame_src, 50);
        let after_one = frame.clone();

        // Ten more re-writes, each restoring first.
        for _ in 0..10 {
            assert!(restore_backdrop(&mut frame, 4, &place, &backdrop));
            blend(&mut frame, 4, 4, &place, frame_src, 50);
        }
        assert_eq!(frame, after_one, "repeated blends drifted");
    }

    #[test]
    fn without_a_restore_repeated_blends_do_drift() {
        // The counterpart: proof the guard is load-bearing rather than
        // ceremonial.
        let place = Placement {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
        };
        let src = solid(2, 2, [255, 255, 255, 255]);
        let frame_src = SourceFrame {
            pixels: &src,
            width: 2,
            height: 2,
        };
        let mut frame = solid(2, 2, [0, 0, 0, 255]);
        blend(&mut frame, 2, 2, &place, frame_src, 50);
        let after_one = frame[0];
        blend(&mut frame, 2, 2, &place, frame_src, 50);
        assert!(
            frame[0] > after_one,
            "a second blend should have lightened toward white"
        );
    }

    #[test]
    fn a_backdrop_only_covers_the_overlay() {
        // The cost bound, asserted rather than asserted-in-prose.
        let frame = solid(100, 100, [0, 0, 0, 255]);
        let place = Placement {
            x: 10,
            y: 10,
            width: 4,
            height: 4,
        };
        let mut backdrop = Vec::new();
        save_backdrop(&frame, 100, &place, &mut backdrop);
        assert_eq!(backdrop.len(), place.backdrop_len(100));
        assert_eq!(backdrop.len(), 4 * 4 * 4);
    }

    #[test]
    fn restoring_a_mismatched_backdrop_is_refused() {
        let mut frame = solid(4, 4, [0, 0, 0, 255]);
        let place = Placement {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
        };
        assert!(!restore_backdrop(&mut frame, 4, &place, &[1, 2, 3]));
    }

    // ---------- placement ----------

    #[test]
    fn a_normalized_rect_scales_with_the_frame() {
        // The property that lets a recording preset carry a source list:
        // the same corner on a different-sized region.
        let s = source(NormRect {
            x: 0.75,
            y: 0.75,
            w: 0.25,
            h: 0.25,
        });
        let small = placement(&s, 400, 400).unwrap();
        let large = placement(&s, 800, 800).unwrap();
        assert_eq!((small.x, small.width), (300, 100));
        assert_eq!((large.x, large.width), (600, 200));
    }

    #[test]
    fn order_alignment_only_swaps_when_it_has_to() {
        let mut px = [1u8, 2, 3, 255];
        align_order(&mut px, PixelOrder::Bgra, PixelOrder::Bgra);
        assert_eq!(px, [1, 2, 3, 255]);
        align_order(&mut px, PixelOrder::Bgra, PixelOrder::Rgba);
        assert_eq!(px, [3, 2, 1, 255]);
    }
}
