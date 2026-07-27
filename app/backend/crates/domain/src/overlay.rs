//! Overlay-feature domain types + pure rules.
//!
//! `domain/` has no I/O, no Tauri, no filesystem — these types and
//! helpers are unit-testable without a desktop session. Everything
//! that needs to touch the OS lives in `services/overlay_service.rs`.
//!
//! Wire format: kebab-case enums (`"region"`, `"color-pick"`),
//! camelCase struct fields (mirrors the capture domain). The
//! `OverlayMode` enum reserves variants for future ports (Color-Pick,
//! Object, Freehand, …) so the wire shape doesn't break when those
//! ports land — but only `Region` is reachable from `validate_mode`
//! today.

use serde::{Deserialize, Serialize};

/// Physical-pixel rectangle, virtual-desktop-origin coordinates.
///
/// The overlay window spans `virtual_bounds()` (sum of all monitors),
/// so a Region whose `(x, y)` is `(0, 0)` is the top-left of the
/// virtual desktop. The frontend multiplies by `devicePixelRatio` at
/// the IPC seam, so these are always physical pixels.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// A capturable top-level window surfaced to the overlay's Window
/// mode. `rect` is physical-pixel, virtual-desktop-origin — the same
/// coordinate space as [`Region`], so the frontend hands it straight
/// back to `finish_region_capture` on click (no extra DPR scaling).
/// `id` is the source HWND's bits, stable for the session; the
/// frontend uses it only as a hover identity / React key.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OverlayWindow {
    pub id: u64,
    pub title: String,
    pub app: String,
    pub rect: Region,
}

/// What the user is doing inside the overlay. Most variants are
/// reserved for follow-up ports (each pinned at the wire-format
/// level so adding them later doesn't reshape the IPC).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayMode {
    /// Drag-to-select rectangle → crop the snapshot → save + emit.
    #[default]
    Region,
    /// Hover a top-level window → highlight it → click to crop that
    /// window's frame bounds out of the snapshot → save + emit. Shares
    /// the entire Region finalize pipeline (the window's frame is just
    /// a pre-snapped [`Region`]).
    Window,
    /// Reserved (Color-Pick port).
    ColorPick,
    /// Reserved (Freehand-lasso port).
    Freehand,
    /// Pen / Bézier-path selection — anchor points + curve handles
    /// flattened to a polygon frontend-side, then masked exactly like
    /// Freehand (shares `finish_freehand_capture`).
    Pen,
    /// Magnetic-lasso selection — an edge-snapped trace flattened to a
    /// polygon frontend-side, masked exactly like Freehand (shares
    /// `finish_freehand_capture`).
    MagneticLasso,
    /// Brush selection — a painted raster alpha mask. Unlike the
    /// polygon modes it can't be represented as a path, so it has its
    /// own finalize (`finish_brush_capture`).
    Brush,
    /// Reserved (Multi-Area port).
    MultiArea,
    /// Reserved (Object-mode port — per-element detection inside a
    /// window via the UIA tree; builds on Window-mode enumeration).
    Object,
    /// Reserved (Grab-Text / OCR port).
    GrabText,
    /// Reserved (Palette port).
    Palette,
    /// Reserved (Scrolling-capture port).
    Scrolling,
    /// Reserved (Panoramic-capture port).
    Panoramic,
    /// Drag-to-select a rectangle, then **record** it (ADR 0031).
    ///
    /// Shares the whole Region interaction — the same drag, handles and
    /// selection UI — and diverges only at finalize, where the rect
    /// starts a recorder session instead of cropping the snapshot.
    /// A distinct mode rather than a flag on `Region` because the
    /// overlay's banner copy, its finalize branch and its toolbar all
    /// need to know which one the user is doing.
    RecordRegion,
    /// Hover a top-level window, click to **record** it. The recording
    /// counterpart to [`OverlayMode::Window`], sharing its enumeration
    /// and hover highlight.
    RecordWindow,
}

/// User-controllable behaviour mirrors from the capture window. The
/// overlay's bottom bar shows these and finalize sends the freshest
/// values via `clippity://overlay/toggles`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OverlayToggles {
    /// Open the captured image in the editor after save.
    pub preview: bool,
    /// Copy the captured PNG to the system clipboard.
    pub clipboard: bool,
    /// Composite the system cursor onto the capture before crop.
    pub cursor: bool,
    /// Run the Smart-enhance pass (`domain::enhance`) over the cropped
    /// pixels before they are encoded.
    ///
    /// `#[serde(default)]` so a payload from a frontend that predates
    /// this field still deserializes as "off" rather than failing the
    /// whole capture — the same courtesy `BeginOverlayRequest::output_dir`
    /// gets.
    #[serde(default)]
    pub enhance: bool,
}

/// Sent on `begin_region_capture`. The mode determines what the
/// overlay will do when the user finishes; toggles are kept fresh
/// over the lifetime of the overlay via the toggles event.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BeginOverlayRequest {
    pub mode: OverlayMode,
    /// Optional per-preset save-dir override threaded into the overlay
    /// session and consumed at `finish_region`. `None`/empty = the live
    /// captures dir. See ADR 0004.
    #[serde(default)]
    pub output_dir: Option<String>,
    /// Name of the preset that opened this overlay, for the provenance
    /// record. Rides the session exactly as `output_dir` does — stashed
    /// at `show`, consumed at `finalize`, cleared at `cancel` — because
    /// the capture it describes happens several IPC calls later.
    /// `None` = the user opened the overlay themselves.
    #[serde(default)]
    pub preset: Option<String>,
}

/// Sent on `finish_region_capture`. The frontend has already snapped
/// coordinates to physical pixels (multiplied by DPR).
///
/// `cursor_pin` is the canvas-local position where the cursor should
/// be composited if `toggles.cursor` is on — the user's
/// `lastInSelection` so the cursor lands inside the crop instead of
/// on the floating Capture button.
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FinishRegionRequest {
    pub rect: Region,
    pub cursor_pin: Option<(i32, i32)>,
    pub toggles: OverlayToggles,
}

/// Result of a successful Region capture. Same shape as
/// `domain::capture::CaptureResult` minus the per-capture-mode fields
/// — kept separate so the two features can evolve independently.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OverlayResult {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub path: String,
    /// Mirrors `CaptureResult::preview` — whether the user wants this
    /// capture opened in the editor. Sourced from the finalize request's
    /// toggles (or the scroll session) so `capture/finished` carries the
    /// intent for the overlay/scroll dispatch paths too.
    pub preview: bool,
}

/// Sent on `finish_freehand_capture`. `points` are the lasso path in
/// canvas-local physical pixels (DPR already applied frontend-side),
/// in draw order. `cursor_pin` mirrors `FinishRegionRequest` — the
/// canvas-local pixel the cursor is composited at when `toggles.cursor`
/// is on (clipped to the path's bounding box).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FinishFreehandRequest {
    pub points: Vec<(i32, i32)>,
    pub cursor_pin: Option<(i32, i32)>,
    pub toggles: OverlayToggles,
}

/// Sent on `finish_multi_area_capture`. Each rect is canvas-local
/// physical pixels; the backend crops them and stitches the crops
/// horizontally on a white background (`MULTI_AREA_GAP_PX` between).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FinishMultiAreaRequest {
    pub rects: Vec<Region>,
    pub cursor_pin: Option<(i32, i32)>,
    pub toggles: OverlayToggles,
}

/// A painted brush selection: an 8-bit alpha coverage raster over a
/// canvas-local bounding box, run-length encoded row-major to keep the
/// IPC payload small (a brush stroke is mostly solid/empty runs). `(x, y)`
/// is the box's canvas-local PHYSICAL-pixel top-left; `rle` is a list of
/// `(value, run_length)` pairs whose run lengths sum to `width * height`.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BrushMask {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub rle: Vec<(u8, u32)>,
}

/// Sent on `finish_brush_capture`. The brush mask is already in
/// canvas-local physical pixels (DPR applied frontend-side); the backend
/// composites the snapshot through the mask's alpha. `cursor_pin` mirrors
/// `FinishRegionRequest`.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FinishBrushRequest {
    pub mask: BrushMask,
    pub cursor_pin: Option<(i32, i32)>,
    pub toggles: OverlayToggles,
}

impl BrushMask {
    /// Decode the RLE into a flat row-major `width * height` alpha buffer.
    /// Rejects a mask whose run lengths don't sum to the declared area
    /// (the backend never trusts client-side coords) or whose area is
    /// zero. Pure — unit-tested below.
    pub fn decode(&self) -> Result<Vec<u8>, &'static str> {
        let area = (self.width as usize)
            .checked_mul(self.height as usize)
            .ok_or("brush mask area overflow")?;
        if area == 0 {
            return Err("brush mask has zero area");
        }
        let mut out = Vec::with_capacity(area);
        for &(value, run) in &self.rle {
            for _ in 0..run {
                out.push(value);
            }
            if out.len() > area {
                return Err("brush mask RLE overruns its area");
            }
        }
        if out.len() != area {
            return Err("brush mask RLE underruns its area");
        }
        Ok(out)
    }
}

/// Pure: clamp `region` into `(virtual_w, virtual_h)` and enforce
/// `MIN_REGION_PX` on each side. The frontend already clamps, but
/// the backend never trusts client-side coords. Returns the
/// (possibly clamped) region on success; rejects with a static
/// reason string on failure.
pub fn validate_region(
    region: Region,
    virtual_w: u32,
    virtual_h: u32,
) -> Result<Region, &'static str> {
    if region.width < MIN_REGION_PX || region.height < MIN_REGION_PX {
        return Err("region smaller than minimum");
    }
    if virtual_w == 0 || virtual_h == 0 {
        return Err("virtual desktop has zero area");
    }

    let x = region.x.min(virtual_w.saturating_sub(1));
    let y = region.y.min(virtual_h.saturating_sub(1));
    let max_w = virtual_w.saturating_sub(x);
    let max_h = virtual_h.saturating_sub(y);
    let width = region.width.min(max_w);
    let height = region.height.min(max_h);

    if width < MIN_REGION_PX || height < MIN_REGION_PX {
        return Err("region clipped below minimum after clamping");
    }
    Ok(Region {
        x,
        y,
        width,
        height,
    })
}

/// The last rectangular selection the user finalized, remembered so it
/// can be captured again without re-dragging it ("same spot as last
/// time"). Persisted to `<data>/last-region.json` by
/// `services::last_region_store`, so it survives a restart.
///
/// The canvas dimensions it was taken against are stored alongside the
/// rect. A [`Region`] is only meaningful relative to a particular
/// virtual-desktop size — plug a monitor in, change a resolution, and
/// the same coordinates point somewhere else entirely. Keeping the
/// dimensions is what lets [`resolve_last_region`] tell "the exact same
/// pixels" apart from "coordinates that merely still fit".
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LastRegion {
    pub region: Region,
    pub canvas_width: u32,
    pub canvas_height: u32,
}

/// Pure: resolve a remembered region against the CURRENT virtual-desktop
/// canvas.
///
/// `strict` is the difference between the two ways this is reached:
///
///   - **Overlay restore** (`strict = false`) puts the rect back on
///     screen as an editable selection. The user sees it and confirms,
///     so a display layout change is survivable — clamp the rect into
///     the new bounds and let them adjust.
///   - **One-shot recapture** (`strict = true`) fires immediately with
///     nothing to review. If the canvas has changed size, the stored
///     coordinates no longer address the pixels the user meant, so this
///     refuses rather than silently capturing the wrong area.
pub fn resolve_last_region(
    last: LastRegion,
    canvas_w: u32,
    canvas_h: u32,
    strict: bool,
) -> Result<Region, &'static str> {
    if strict && (last.canvas_width != canvas_w || last.canvas_height != canvas_h) {
        return Err("display layout changed since that region was captured");
    }
    validate_region(last.region, canvas_w, canvas_h)
}

/// Minimum side length (physical pixels) for a usable Region capture.
/// Matches the frontend `geometry.ts` `MIN_SIZE` constant — coordinate
/// these in lock-step.
pub const MIN_REGION_PX: u32 = 8;

/// Minimum points for a usable freehand path. Below this there's no
/// enclosed area to mask. Matches the frontend gate so the overlay
/// won't offer a finalize the backend would reject.
pub const MIN_FREEHAND_POINTS: usize = 3;

/// Gap (physical pixels) between crops in a Multi-Area stitch.
/// Inherited from the legacy `composite_multi_area(gap = 12)`.
pub const MULTI_AREA_GAP_PX: u32 = 12;

/// Even-odd ray-cast point-in-polygon test. `(x, y)` and `poly` are
/// integer pixel coordinates; the ray is cast in +x and edge crossings
/// counted. The `(yi > y) != (yj > y)` guard excludes horizontal edges
/// and keeps the slope division safe. Returns false for degenerate
/// (< 3-point) polygons. Pure — ported from the legacy `capture.rs`.
pub fn point_in_polygon(x: i32, y: i32, poly: &[(i32, i32)]) -> bool {
    if poly.len() < MIN_FREEHAND_POINTS {
        return false;
    }
    let (xf, yf) = (x as f64, y as f64);
    let mut inside = false;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (poly[i].0 as f64, poly[i].1 as f64);
        let (xj, yj) = (poly[j].0 as f64, poly[j].1 as f64);
        if (yi > yf) != (yj > yf) {
            let xint = (xj - xi) * (yf - yi) / (yj - yi) + xi;
            if xf < xint {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

/// Axis-aligned bounding box of `points` as `(min_x, min_y, max_x,
/// max_y)`, or `None` when empty. Pure.
pub fn polygon_bounds(points: &[(i32, i32)]) -> Option<(i32, i32, i32, i32)> {
    let mut it = points.iter();
    let &(fx, fy) = it.next()?;
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (fx, fy, fx, fy);
    for &(px, py) in it {
        min_x = min_x.min(px);
        min_y = min_y.min(py);
        max_x = max_x.max(px);
        max_y = max_y.max(py);
    }
    Some((min_x, min_y, max_x, max_y))
}

#[cfg(test)]
mod last_region_tests {
    use super::*;

    fn last(region: Region, w: u32, h: u32) -> LastRegion {
        LastRegion {
            region,
            canvas_width: w,
            canvas_height: h,
        }
    }

    fn rect(x: u32, y: u32, width: u32, height: u32) -> Region {
        Region {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn returns_the_exact_rect_when_the_canvas_is_unchanged() {
        let r = rect(100, 200, 640, 480);
        assert_eq!(
            resolve_last_region(last(r, 3840, 1080), 3840, 1080, true),
            Ok(r)
        );
    }

    #[test]
    fn strict_refuses_a_resized_canvas_even_when_the_rect_still_fits() {
        // The rect fits inside 1920×1080 — but those coordinates now
        // address different pixels than the user selected, and the
        // one-shot path has no preview to catch that.
        let r = rect(100, 200, 640, 480);
        assert!(resolve_last_region(last(r, 3840, 1080), 1920, 1080, true).is_err());
    }

    #[test]
    fn non_strict_accepts_a_resized_canvas() {
        // The overlay shows this as an editable selection first, so a
        // best-effort restore beats refusing outright.
        let r = rect(100, 200, 640, 480);
        assert_eq!(
            resolve_last_region(last(r, 3840, 1080), 1920, 1080, false),
            Ok(r)
        );
    }

    #[test]
    fn non_strict_clamps_a_rect_that_overhangs_the_new_canvas() {
        let r = rect(1800, 900, 640, 480);
        let got = resolve_last_region(last(r, 3840, 1080), 1920, 1080, false)
            .expect("clamped into the smaller canvas");
        assert_eq!(got.x, 1800);
        assert_eq!(got.y, 900);
        assert_eq!(got.width, 120); // 1920 - 1800
        assert_eq!(got.height, 180); // 1080 - 900
    }

    #[test]
    fn rejects_a_rect_that_clamps_below_the_minimum() {
        // Origin sits within 4 px of the right edge — nothing usable is
        // left after clamping, so this must not resolve.
        let r = rect(1917, 100, 640, 480);
        assert!(resolve_last_region(last(r, 3840, 1080), 1920, 1080, false).is_err());
    }

    #[test]
    fn round_trips_through_json_camel_case() {
        let value = last(rect(1, 2, 3, 4), 100, 200);
        let json = serde_json::to_string(&value).unwrap();
        assert!(json.contains("\"canvasWidth\":100"), "got {json}");
        assert_eq!(serde_json::from_str::<LastRegion>(&json).unwrap(), value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_mode_round_trip_kebab() {
        let json = serde_json::to_string(&OverlayMode::ColorPick).unwrap();
        assert_eq!(json, "\"color-pick\"");
        let parsed: OverlayMode = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, OverlayMode::ColorPick);
    }

    #[test]
    fn brush_mode_round_trip_kebab() {
        let parsed: OverlayMode = serde_json::from_str("\"magnetic-lasso\"").unwrap();
        assert_eq!(parsed, OverlayMode::MagneticLasso);
        let parsed: OverlayMode = serde_json::from_str("\"pen\"").unwrap();
        assert_eq!(parsed, OverlayMode::Pen);
        let parsed: OverlayMode = serde_json::from_str("\"brush\"").unwrap();
        assert_eq!(parsed, OverlayMode::Brush);
    }

    #[test]
    fn brush_mask_decode_round_trips_runs() {
        // 3×2 = 6 px: two opaque, two empty, two opaque.
        let mask = BrushMask {
            x: 4,
            y: 5,
            width: 3,
            height: 2,
            rle: vec![(255, 2), (0, 2), (255, 2)],
        };
        assert_eq!(mask.decode().unwrap(), vec![255, 255, 0, 0, 255, 255]);
    }

    #[test]
    fn brush_mask_decode_rejects_length_mismatch() {
        let short = BrushMask {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
            rle: vec![(255, 3)],
        };
        assert!(short.decode().is_err());
        let long = BrushMask {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
            rle: vec![(255, 9)],
        };
        assert!(long.decode().is_err());
    }

    #[test]
    fn brush_mask_decode_rejects_zero_area() {
        let empty = BrushMask {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            rle: vec![],
        };
        assert!(empty.decode().is_err());
    }

    #[test]
    fn overlay_mode_window_round_trip() {
        let json = serde_json::to_string(&OverlayMode::Window).unwrap();
        assert_eq!(json, "\"window\"");
        let parsed: OverlayMode = serde_json::from_str("\"window\"").unwrap();
        assert_eq!(parsed, OverlayMode::Window);
    }

    #[test]
    fn begin_request_output_dir_defaults_when_absent() {
        // The capture window sends `{ mode }` with no outputDir; the
        // serde default keeps that payload valid.
        let req: BeginOverlayRequest = serde_json::from_str(r#"{"mode":"region"}"#).unwrap();
        assert_eq!(req.mode, OverlayMode::Region);
        assert!(req.output_dir.is_none());
        assert!(req.preset.is_none());
    }

    #[test]
    fn begin_request_carries_the_preset_that_opened_it() {
        let req: BeginOverlayRequest =
            serde_json::from_str(r#"{"mode":"window","preset":"Bug report"}"#).unwrap();
        assert_eq!(req.mode, OverlayMode::Window);
        assert_eq!(req.preset.as_deref(), Some("Bug report"));
    }

    #[test]
    fn overlay_window_serializes_camel_case() {
        let w = OverlayWindow {
            id: 42,
            title: "Untitled - Notepad".into(),
            app: "Notepad".into(),
            rect: Region {
                x: 10,
                y: 20,
                width: 800,
                height: 600,
            },
        };
        let v: serde_json::Value = serde_json::to_value(&w).unwrap();
        assert_eq!(v["id"], 42);
        assert_eq!(v["title"], "Untitled - Notepad");
        assert_eq!(v["app"], "Notepad");
        assert_eq!(v["rect"]["width"], 800);
        assert_eq!(v["rect"]["height"], 600);
    }

    #[test]
    fn overlay_mode_default_is_region() {
        assert_eq!(OverlayMode::default(), OverlayMode::Region);
    }

    #[test]
    fn region_serializes_camel_case() {
        let r = Region {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"width\":3"));
        assert!(json.contains("\"height\":4"));
    }

    #[test]
    fn finish_request_accepts_cursor_pin_or_null() {
        let with_pin: FinishRegionRequest = serde_json::from_str(
            r#"{"rect":{"x":0,"y":0,"width":100,"height":100},"cursorPin":[10,20],"toggles":{"preview":true,"clipboard":false,"cursor":true}}"#,
        )
        .unwrap();
        assert_eq!(with_pin.cursor_pin, Some((10, 20)));

        let without: FinishRegionRequest = serde_json::from_str(
            r#"{"rect":{"x":0,"y":0,"width":100,"height":100},"cursorPin":null,"toggles":{"preview":true,"clipboard":false,"cursor":false}}"#,
        )
        .unwrap();
        assert_eq!(without.cursor_pin, None);
    }

    #[test]
    fn validate_region_clamps_to_virtual_bounds() {
        let r = Region {
            x: 100,
            y: 100,
            width: 10_000,
            height: 10_000,
        };
        let clamped = validate_region(r, 1920, 1080).unwrap();
        assert_eq!(clamped.x, 100);
        assert_eq!(clamped.y, 100);
        assert_eq!(clamped.width, 1820);
        assert_eq!(clamped.height, 980);
    }

    #[test]
    fn validate_region_rejects_below_min() {
        let r = Region {
            x: 0,
            y: 0,
            width: 4,
            height: 4,
        };
        let err = validate_region(r, 1920, 1080).unwrap_err();
        assert_eq!(err, "region smaller than minimum");
    }

    #[test]
    fn validate_region_rejects_clamped_below_min() {
        // Region starts inside bounds but width gets clipped to 4 px.
        let r = Region {
            x: 1916,
            y: 0,
            width: 100,
            height: 100,
        };
        let err = validate_region(r, 1920, 1080).unwrap_err();
        assert_eq!(err, "region clipped below minimum after clamping");
    }

    #[test]
    fn validate_region_rejects_zero_virtual() {
        let r = Region {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        };
        let err = validate_region(r, 0, 1080).unwrap_err();
        assert_eq!(err, "virtual desktop has zero area");
    }

    #[test]
    fn point_in_polygon_inside_outside_and_degenerate() {
        // A 10×10 square (0,0)-(10,10).
        let sq = [(0, 0), (10, 0), (10, 10), (0, 10)];
        assert!(point_in_polygon(5, 5, &sq), "centroid is inside");
        assert!(!point_in_polygon(20, 5, &sq), "far right is outside");
        assert!(!point_in_polygon(-1, 5, &sq), "left of edge is outside");
        // A right-pointing chevron with a concave notch at x=3: even-odd
        // must read the notch (x<3) as outside and the body (x>3) as inside.
        let chevron = [(0, 0), (10, 5), (0, 10), (3, 5)];
        assert!(
            !point_in_polygon(1, 5, &chevron),
            "the concave notch is outside"
        );
        assert!(
            point_in_polygon(6, 5, &chevron),
            "the chevron body is inside"
        );
        // Fewer than 3 points encloses no area.
        assert!(!point_in_polygon(0, 0, &[(0, 0), (1, 1)]));
    }

    #[test]
    fn polygon_bounds_spans_extremes_or_none() {
        assert_eq!(polygon_bounds(&[]), None);
        assert_eq!(polygon_bounds(&[(5, 5)]), Some((5, 5, 5, 5)));
        assert_eq!(
            polygon_bounds(&[(3, -2), (10, 4), (-1, 7)]),
            Some((-1, -2, 10, 7))
        );
    }

    #[test]
    fn finish_freehand_request_round_trips_camel_case() {
        let req: FinishFreehandRequest = serde_json::from_str(
            r#"{"points":[[0,0],[10,0],[5,10]],"cursorPin":[3,3],"toggles":{"preview":false,"clipboard":true,"cursor":true}}"#,
        )
        .unwrap();
        assert_eq!(req.points.len(), 3);
        assert_eq!(req.cursor_pin, Some((3, 3)));
        assert!(req.toggles.clipboard);
    }

    #[test]
    fn finish_multi_area_request_round_trips_camel_case() {
        let req: FinishMultiAreaRequest = serde_json::from_str(
            r#"{"rects":[{"x":0,"y":0,"width":50,"height":40},{"x":80,"y":10,"width":30,"height":60}],"cursorPin":null,"toggles":{"preview":true,"clipboard":false,"cursor":false}}"#,
        )
        .unwrap();
        assert_eq!(req.rects.len(), 2);
        assert_eq!(req.rects[1].width, 30);
        assert_eq!(req.cursor_pin, None);
    }
}
