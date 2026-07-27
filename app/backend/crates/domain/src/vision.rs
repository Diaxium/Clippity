//! Vision domain — pure object-detection post-processing. **No I/O,
//! no ort.** `services::vision_service` owns the ONNX session and feeds
//! raw output tensors through these helpers; everything here is
//! unit-testable with hand-built slices.
//!
//! Supported detector head formats (dispatched on output shape):
//!
//! - **End-to-end** `[1, N, 6]` — YOLOv10-style NMS-free export. Each
//!   row is `(x1, y1, x2, y2, score, class_id)` in letterboxed input
//!   pixels.
//! - **Raw** `[1, 4 + C, A]` — YOLOv8-style export (OmniParser's icon
//!   detector). Channels are `(cx, cy, w, h, class scores…)` over `A`
//!   anchors; needs score-filtering + NMS here.
//!
//! Coordinates flow: model input px → un-letterbox → tile-local px →
//! offset by tile origin → canvas px (`Region`).

use serde::Serialize;

use crate::overlay::Region;

/// One detected object in canvas-local physical pixels — the wire
/// shape served to the overlay's Object mode.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedObject {
    pub rect: Region,
    pub label: String,
    /// 0.0–1.0 detector confidence.
    pub confidence: f32,
}

/// Intermediate detection in f32 canvas coords (pre-clamp, pre-wire).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RawDetection {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub score: f32,
    pub class_id: usize,
}

/// Minimum side (px) a detection must have to be a usable capture
/// target — mirrors `MIN_REGION_PX` with headroom for the click UX.
pub const MIN_DETECTION_PX: f32 = 12.0;

/// IoU threshold for the raw-head NMS pass and the cross-tile merge.
pub const NMS_IOU: f32 = 0.45;

/// Hard cap on detections returned per request — keeps the overlay
/// render + hit-test cheap even when a busy desktop yields hundreds.
pub const MAX_DETECTIONS: usize = 192;

// ---------------------------------------------------------------- letterbox

/// Letterbox mapping: `scale` + `(pad_x, pad_y)` that fit a
/// `src_w × src_h` image into a square `input × input` canvas,
/// preserving aspect, centered.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Letterbox {
    pub scale: f32,
    pub pad_x: f32,
    pub pad_y: f32,
}

impl Letterbox {
    pub fn fit(src_w: u32, src_h: u32, input: u32) -> Self {
        let scale = (input as f32 / src_w as f32).min(input as f32 / src_h as f32);
        let pad_x = (input as f32 - src_w as f32 * scale) / 2.0;
        let pad_y = (input as f32 - src_h as f32 * scale) / 2.0;
        Self {
            scale,
            pad_x,
            pad_y,
        }
    }

    /// Map an input-space coordinate back to source-image space.
    #[inline]
    pub fn unmap_x(&self, x: f32) -> f32 {
        (x - self.pad_x) / self.scale
    }

    #[inline]
    pub fn unmap_y(&self, y: f32) -> f32 {
        (y - self.pad_y) / self.scale
    }
}

// ---------------------------------------------------------------- decoding

/// Decode an end-to-end head (`[1, N, 6]` flattened to `data`,
/// `rows = N`). Rows are `(x1, y1, x2, y2, score, class)` in input px;
/// already NMS'd by the export, so only confidence-filter + un-letterbox.
pub fn decode_e2e(data: &[f32], rows: usize, lb: Letterbox, conf: f32) -> Vec<RawDetection> {
    let mut out = Vec::new();
    for r in 0..rows {
        let base = r * 6;
        let Some(chunk) = data.get(base..base + 6) else {
            break;
        };
        let score = chunk[4];
        if score < conf {
            continue;
        }
        out.push(RawDetection {
            x1: lb.unmap_x(chunk[0]),
            y1: lb.unmap_y(chunk[1]),
            x2: lb.unmap_x(chunk[2]),
            y2: lb.unmap_y(chunk[3]),
            score,
            class_id: chunk[5] as usize,
        });
    }
    out
}

/// Decode a raw YOLOv8-style head (`[1, 4 + C, A]` flattened to
/// `data`; `channels = 4 + C`, `anchors = A`). Picks the best class
/// per anchor, confidence-filters, un-letterboxes, then NMS.
pub fn decode_raw(
    data: &[f32],
    channels: usize,
    anchors: usize,
    lb: Letterbox,
    conf: f32,
) -> Vec<RawDetection> {
    if channels < 5 || data.len() < channels * anchors {
        return Vec::new();
    }
    let classes = channels - 4;
    let mut out = Vec::new();
    for a in 0..anchors {
        // Best class score for this anchor.
        let (mut best_c, mut best_s) = (0usize, f32::MIN);
        for c in 0..classes {
            let s = data[(4 + c) * anchors + a];
            if s > best_s {
                best_s = s;
                best_c = c;
            }
        }
        if best_s < conf {
            continue;
        }
        let cx = data[a];
        let cy = data[anchors + a];
        let w = data[2 * anchors + a];
        let h = data[3 * anchors + a];
        out.push(RawDetection {
            x1: lb.unmap_x(cx - w / 2.0),
            y1: lb.unmap_y(cy - h / 2.0),
            x2: lb.unmap_x(cx + w / 2.0),
            y2: lb.unmap_y(cy + h / 2.0),
            score: best_s,
            class_id: best_c,
        });
    }
    nms(out, NMS_IOU)
}

/// Intersection-over-union of two detections.
pub fn iou(a: &RawDetection, b: &RawDetection) -> f32 {
    let ix = (a.x2.min(b.x2) - a.x1.max(b.x1)).max(0.0);
    let iy = (a.y2.min(b.y2) - a.y1.max(b.y1)).max(0.0);
    let inter = ix * iy;
    let area_a = (a.x2 - a.x1).max(0.0) * (a.y2 - a.y1).max(0.0);
    let area_b = (b.x2 - b.x1).max(0.0) * (b.y2 - b.y1).max(0.0);
    let union = area_a + area_b - inter;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

/// Greedy class-agnostic non-maximum suppression, highest score first.
/// Class-agnostic on purpose: for capture targets, two overlapping
/// boxes are the same click target regardless of predicted class.
pub fn nms(mut dets: Vec<RawDetection>, iou_thresh: f32) -> Vec<RawDetection> {
    dets.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut keep: Vec<RawDetection> = Vec::with_capacity(dets.len());
    'outer: for d in dets {
        for k in &keep {
            if iou(&d, k) > iou_thresh {
                continue 'outer;
            }
        }
        keep.push(d);
    }
    keep
}

// ---------------------------------------------------------------- tiling

/// Plan covering tiles for a `w × h` canvas. Tiles are at most
/// `tile × tile`, stepped by `tile - overlap` so neighbours share
/// `overlap` px (detections split across a seam survive the merge
/// NMS). Degenerates to a single canvas-sized tile when the canvas is
/// smaller than `tile`. Caps the grid at `max_tiles` by growing the
/// effective tile size — a 3-monitor desktop shouldn't queue 40
/// inferences.
pub fn plan_tiles(w: u32, h: u32, tile: u32, overlap: u32, max_tiles: usize) -> Vec<Region> {
    if w == 0 || h == 0 {
        return Vec::new();
    }
    let mut tile = tile.max(overlap.saturating_mul(2)).max(64);
    loop {
        let step = (tile - overlap).max(1);
        let cols = if w <= tile {
            1
        } else {
            ((w - overlap) as usize).div_ceil(step as usize)
        };
        let rows = if h <= tile {
            1
        } else {
            ((h - overlap) as usize).div_ceil(step as usize)
        };
        if cols * rows <= max_tiles {
            let mut out = Vec::with_capacity(cols * rows);
            for r in 0..rows {
                for c in 0..cols {
                    let x = (c as u32 * step).min(w.saturating_sub(tile.min(w)));
                    let y = (r as u32 * step).min(h.saturating_sub(tile.min(h)));
                    out.push(Region {
                        x,
                        y,
                        width: tile.min(w - x),
                        height: tile.min(h - y),
                    });
                }
            }
            return out;
        }
        // Too many tiles — grow by half a tile and re-plan.
        tile = tile.saturating_add(tile / 2).min(w.max(h));
    }
}

// ---------------------------------------------------------------- finalize

/// Merge per-tile detections (already offset to canvas coords) into the
/// final wire list: cross-tile NMS, clamp to the canvas, drop slivers,
/// cap the count, resolve labels.
pub fn finalize(
    dets: Vec<RawDetection>,
    canvas_w: u32,
    canvas_h: u32,
    labels: &[&str],
) -> Vec<DetectedObject> {
    let mut out = Vec::new();
    for d in nms(dets, NMS_IOU) {
        let x1 = d.x1.clamp(0.0, canvas_w as f32);
        let y1 = d.y1.clamp(0.0, canvas_h as f32);
        let x2 = d.x2.clamp(0.0, canvas_w as f32);
        let y2 = d.y2.clamp(0.0, canvas_h as f32);
        if x2 - x1 < MIN_DETECTION_PX || y2 - y1 < MIN_DETECTION_PX {
            continue;
        }
        out.push(DetectedObject {
            rect: Region {
                x: x1 as u32,
                y: y1 as u32,
                width: (x2 - x1) as u32,
                height: (y2 - y1) as u32,
            },
            label: labels
                .get(d.class_id)
                .copied()
                .unwrap_or("object")
                .to_string(),
            confidence: d.score.clamp(0.0, 1.0),
        });
        if out.len() >= MAX_DETECTIONS {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn det(x1: f32, y1: f32, x2: f32, y2: f32, score: f32) -> RawDetection {
        RawDetection {
            x1,
            y1,
            x2,
            y2,
            score,
            class_id: 0,
        }
    }

    // ---------- letterbox ----------

    #[test]
    fn letterbox_wide_source_pads_vertically() {
        let lb = Letterbox::fit(1280, 720, 640);
        assert!((lb.scale - 0.5).abs() < 1e-6);
        assert_eq!(lb.pad_x, 0.0);
        assert_eq!(lb.pad_y, (640.0 - 360.0) / 2.0);
        // Round trip: input-space y=140 (top of content) → src y=0.
        assert!((lb.unmap_y(140.0) - 0.0).abs() < 1e-4);
        assert!((lb.unmap_x(640.0) - 1280.0).abs() < 1e-4);
    }

    #[test]
    fn letterbox_square_source_is_pure_scale() {
        let lb = Letterbox::fit(320, 320, 640);
        assert_eq!(lb.scale, 2.0);
        assert_eq!((lb.pad_x, lb.pad_y), (0.0, 0.0));
        assert_eq!(lb.unmap_x(640.0), 320.0);
    }

    // ---------- decode_e2e ----------

    #[test]
    fn decode_e2e_filters_by_confidence_and_unmaps() {
        let lb = Letterbox::fit(640, 640, 640); // identity
                                                // Two rows: one above threshold, one below.
        let data = [
            10.0, 20.0, 110.0, 220.0, 0.9, 3.0, //
            0.0, 0.0, 50.0, 50.0, 0.1, 1.0,
        ];
        let dets = decode_e2e(&data, 2, lb, 0.5);
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].class_id, 3);
        assert!((dets[0].x1 - 10.0).abs() < 1e-5);
        assert!((dets[0].y2 - 220.0).abs() < 1e-5);
    }

    #[test]
    fn decode_e2e_tolerates_truncated_data() {
        let lb = Letterbox::fit(640, 640, 640);
        let data = [10.0, 20.0, 110.0, 220.0, 0.9]; // 5 floats, not 6
        assert!(decode_e2e(&data, 1, lb, 0.5).is_empty());
    }

    // ---------- decode_raw ----------

    #[test]
    fn decode_raw_picks_best_class_and_converts_cxcywh() {
        let lb = Letterbox::fit(640, 640, 640); // identity
                                                // channels = 4 + 2 classes, anchors = 2. Channel-major layout.
                                                // Anchor 0: cx=100 cy=100 w=40 h=20, class scores (0.2, 0.8)
                                                // Anchor 1: cx=300 cy=300 w=10 h=10, class scores (0.3, 0.1)
        let data = [
            100.0, 300.0, // cx
            100.0, 300.0, // cy
            40.0, 10.0, // w
            20.0, 10.0, // h
            0.2, 0.3, // class 0
            0.8, 0.1, // class 1
        ];
        let dets = decode_raw(&data, 6, 2, lb, 0.5);
        assert_eq!(dets.len(), 1);
        let d = dets[0];
        assert_eq!(d.class_id, 1);
        assert!((d.x1 - 80.0).abs() < 1e-5);
        assert!((d.y1 - 90.0).abs() < 1e-5);
        assert!((d.x2 - 120.0).abs() < 1e-5);
        assert!((d.y2 - 110.0).abs() < 1e-5);
    }

    #[test]
    fn decode_raw_rejects_malformed_shapes() {
        let lb = Letterbox::fit(640, 640, 640);
        assert!(
            decode_raw(&[1.0; 8], 4, 2, lb, 0.5).is_empty(),
            "channels < 5"
        );
        assert!(
            decode_raw(&[1.0; 4], 6, 2, lb, 0.5).is_empty(),
            "data too short"
        );
    }

    // ---------- iou / nms ----------

    #[test]
    fn iou_disjoint_is_zero_identical_is_one() {
        let a = det(0.0, 0.0, 10.0, 10.0, 1.0);
        let b = det(20.0, 20.0, 30.0, 30.0, 1.0);
        assert_eq!(iou(&a, &b), 0.0);
        assert!((iou(&a, &a) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn nms_keeps_highest_score_of_overlapping_pair() {
        let dets = vec![
            det(0.0, 0.0, 100.0, 100.0, 0.7),
            det(5.0, 5.0, 105.0, 105.0, 0.9), // heavy overlap, higher score
            det(300.0, 300.0, 400.0, 400.0, 0.5), // far away — survives
        ];
        let kept = nms(dets, 0.45);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].score, 0.9);
        assert_eq!(kept[1].score, 0.5);
    }

    // ---------- plan_tiles ----------

    #[test]
    fn plan_tiles_small_canvas_is_single_tile() {
        let tiles = plan_tiles(800, 600, 960, 160, 16);
        assert_eq!(tiles.len(), 1);
        assert_eq!(
            tiles[0],
            Region {
                x: 0,
                y: 0,
                width: 800,
                height: 600
            }
        );
    }

    #[test]
    fn plan_tiles_covers_every_pixel_with_overlap() {
        let (w, h, tile, overlap) = (1920u32, 1080u32, 960u32, 160u32);
        let tiles = plan_tiles(w, h, tile, overlap, 16);
        assert!(!tiles.is_empty());
        // Right/bottom edges must be reached.
        assert!(tiles.iter().any(|t| t.x + t.width == w));
        assert!(tiles.iter().any(|t| t.y + t.height == h));
        // Every tile stays in bounds.
        for t in &tiles {
            assert!(t.x + t.width <= w && t.y + t.height <= h, "{t:?}");
        }
    }

    #[test]
    fn plan_tiles_respects_max_by_growing_tile() {
        // A huge tri-monitor canvas with a small tile would need dozens
        // of tiles; the planner must grow the tile to fit the cap.
        let tiles = plan_tiles(7680, 2160, 640, 128, 12);
        assert!(tiles.len() <= 12, "{}", tiles.len());
    }

    #[test]
    fn plan_tiles_zero_canvas_is_empty() {
        assert!(plan_tiles(0, 1080, 960, 160, 16).is_empty());
    }

    // ---------- finalize ----------

    #[test]
    fn finalize_clamps_drops_slivers_and_labels() {
        let dets = vec![
            det(-10.0, -10.0, 50.0, 50.0, 0.8),   // clamped to 0
            det(100.0, 100.0, 104.0, 200.0, 0.9), // 4px wide — dropped
        ];
        let out = finalize(dets, 1920, 1080, &["button"]);
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0].rect,
            Region {
                x: 0,
                y: 0,
                width: 50,
                height: 50
            }
        );
        assert_eq!(out[0].label, "button");
    }

    #[test]
    fn finalize_unknown_class_falls_back_to_object() {
        let mut d = det(0.0, 0.0, 100.0, 100.0, 0.8);
        d.class_id = 99;
        let out = finalize(vec![d], 1920, 1080, &["button"]);
        assert_eq!(out[0].label, "object");
    }

    #[test]
    fn finalize_caps_detection_count() {
        let mut dets = Vec::new();
        for i in 0..(MAX_DETECTIONS + 50) {
            // Disjoint boxes so NMS keeps them all.
            let x = (i as f32) * 20.0;
            dets.push(det(x, 0.0, x + 15.0, 15.0, 0.9));
        }
        let out = finalize(dets, 1_000_000, 1080, &["button"]);
        assert_eq!(out.len(), MAX_DETECTIONS);
    }
}
