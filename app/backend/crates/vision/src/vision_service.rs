//! Object detection — runs the installed ONNX detector over a desktop
//! snapshot and returns canvas-space boxes for the overlay's Object
//! mode.
//!
//! Pipeline per request:
//!   1. Plan covering tiles over the canvas (`domain::vision::plan_tiles`)
//!      — a 640-px detector over an unbroken 4K+ virtual desktop would
//!      miss everything smaller than a window, so inference runs per
//!      tile and the results are merged with cross-tile NMS.
//!   2. Per tile: crop → letterbox to the model's square input
//!      (gray 114 padding, YOLO convention) → CHW f32 → `session.run`.
//!   3. Decode by output shape (`[1, N, 6]` end-to-end vs `[1, 4+C, A]`
//!      raw — see `domain::vision`), un-letterbox, offset to canvas
//!      coords.
//!   4. `finalize`: merge-NMS, clamp, drop slivers, resolve labels.
//!
//! The ONNX session is cached per model id and rebuilt only when the
//! configured model changes (or `invalidate` drops it after a model
//! file is removed). All post-processing math lives in
//! `domain::vision` where it's unit-tested; this service owns only the
//! ort + image I/O glue.

use std::path::Path;
use std::sync::Mutex;

use image::RgbaImage;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::{Tensor, ValueType};

use clippity_domain::models::ModelSpec;
use clippity_domain::overlay::Region;
use clippity_domain::vision::{
    decode_e2e, decode_raw, finalize, DetectedObject, Letterbox, RawDetection,
};
use clippity_infra::error::{AppError, AppResult};

/// Tile overlap as a fraction of the tile edge — a quarter-tile seam,
/// wide enough that an element split by a tile boundary lands fully
/// inside at least one neighbour.
const TILE_OVERLAP_DIV: u32 = 4;

/// Hard cap on inferences per request — bounds worst-case latency on
/// large multi-monitor desktops (the planner grows tiles to fit).
const MAX_TILES: usize = 12;

/// YOLO letterbox padding value (gray 114).
const PAD_VALUE: f32 = 114.0 / 255.0;

/// Neutral grey the typer pads its square crop canvas with — must match
/// the classifier's training letterbox (RGB 128).
const TYPER_PAD: u8 = 128;

/// ImageNet normalization the typer was trained with (torchvision
/// default): `(pixel/255 - MEAN) / STD` per channel.
const TYPER_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const TYPER_STD: [f32; 3] = [0.229, 0.224, 0.225];

/// Crops classified per typer inference — bounds the transient input
/// tensor (a full 192-detection desktop would otherwise be one ~115 MB
/// batch).
const TYPER_BATCH: usize = 64;

struct LoadedModel {
    id: String,
    input_name: String,
    output_name: String,
    /// Square input edge the model actually declares (NCHW H==W), or
    /// the registry's `input_size` when the model's input is dynamic.
    input_size: u32,
    session: Session,
    /// Second-stage crop classifier (typed models only). `None` leaves
    /// detections with their detector label.
    typer: Option<LoadedTyper>,
}

/// A cached typer session + the metadata to feed and read it.
struct LoadedTyper {
    input_name: String,
    output_name: String,
    /// Square input edge the classifier expects (e.g. 224).
    input_size: u32,
    /// Box-padding fraction applied before cropping (training-matched).
    crop_pad: f32,
    /// Type labels in model output order (argmax index → label).
    labels: &'static [&'static str],
    session: Session,
}

/// Caches one live ONNX session (the configured object detector).
pub struct VisionService {
    current: Mutex<Option<LoadedModel>>,
}

impl Default for VisionService {
    fn default() -> Self {
        Self::new()
    }
}

impl VisionService {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }

    /// Drop the cached session when it belongs to `id` — called after a
    /// model file is removed so a stale in-memory session can't outlive
    /// its artifact.
    pub fn invalidate(&self, id: &str) {
        if let Ok(mut guard) = self.current.lock() {
            if guard.as_ref().is_some_and(|m| m.id == id) {
                *guard = None;
            }
        }
    }

    /// Drop the cached session unconditionally, freeing the model weights
    /// (tens of MB) held resident after a detection. Called when the app
    /// drops to the tray (no primary window visible) so idle/background
    /// RAM doesn't carry an ONNX session the user isn't using. Safe and
    /// self-healing: `detect` lazily rebuilds the session on the next
    /// object-mode capture. Returns whether a session was actually freed.
    pub fn release(&self) -> bool {
        match self.current.lock() {
            Ok(mut guard) => guard.take().is_some(),
            Err(_) => false,
        }
    }

    /// Detect objects on `canvas` with the model at `model_path`.
    /// `confidence` is the 0.0–1.0 score floor. Returns canvas-space
    /// boxes, highest confidence first within NMS order.
    pub fn detect(
        &self,
        canvas: &RgbaImage,
        spec: &ModelSpec,
        model_path: &Path,
        typer_path: Option<&Path>,
        confidence: f32,
    ) -> AppResult<Vec<DetectedObject>> {
        if canvas.width() == 0 || canvas.height() == 0 {
            return Err(AppError::Vision("empty canvas".into()));
        }

        let mut guard = self
            .current
            .lock()
            .map_err(|_| AppError::Vision("vision session lock poisoned".into()))?;

        // (Re)build the session when the configured model changed.
        if guard.as_ref().map(|m| m.id.as_str()) != Some(spec.id) {
            *guard = None; // free the old session before loading the new
            let session = build_session(model_path)?;
            let input_name = session
                .inputs()
                .first()
                .map(|i| i.name().to_string())
                .ok_or_else(|| AppError::Vision("model has no inputs".into()))?;
            let output_name = session
                .outputs()
                .first()
                .map(|o| o.name().to_string())
                .ok_or_else(|| AppError::Vision("model has no outputs".into()))?;
            // Prefer the model's declared square input edge; fall back to
            // the registry hint when the input is dynamic (-1 dims).
            let input_size = session
                .inputs()
                .first()
                .and_then(|i| declared_input_size(i.dtype()))
                .unwrap_or(spec.input_size);
            // Typed models load a second classifier alongside the
            // detector. A missing typer file degrades to detection-only
            // rather than failing the whole capture.
            let typer = build_typer(spec, typer_path)?;
            tracing::info!(
                model = spec.id,
                input_size,
                typed = typer.is_some(),
                "vision session loaded"
            );
            *guard = Some(LoadedModel {
                id: spec.id.to_string(),
                input_name,
                output_name,
                input_size,
                session,
                typer,
            });
        }
        let model = guard.as_mut().expect("session just ensured");

        let started = std::time::Instant::now();
        let input = model.input_size;
        // Tile at 1:1 with the model input so a screen pixel maps to a
        // model pixel — no downscale, so small UI elements (the point of
        // the recommended detector) stay above the model's effective
        // minimum size. The planner grows tiles to honour MAX_TILES on
        // very large desktops (trading some small-element recall for
        // bounded latency).
        let tiles = clippity_domain::vision::plan_tiles(
            canvas.width(),
            canvas.height(),
            input,
            input / TILE_OVERLAP_DIV,
            MAX_TILES,
        );

        let mut all: Vec<RawDetection> = Vec::new();
        for tile in &tiles {
            let lb = Letterbox::fit(tile.width, tile.height, input);
            let tensor_data = preprocess_tile(canvas, *tile, input, lb);
            let tensor =
                Tensor::from_array(([1usize, 3, input as usize, input as usize], tensor_data))
                    .map_err(|e| AppError::Vision(format!("input tensor: {e}")))?;
            let outputs = model
                .session
                .run(ort::inputs![model.input_name.as_str() => tensor])
                .map_err(|e| AppError::Vision(format!("inference: {e}")))?;
            let output = outputs
                .get(model.output_name.as_str())
                .ok_or_else(|| AppError::Vision("model output missing".into()))?;
            let (shape, data) = output
                .try_extract_tensor::<f32>()
                .map_err(|e| AppError::Vision(format!("output tensor: {e}")))?;
            let dims: Vec<usize> = shape.iter().map(|d| *d as usize).collect();

            let dets = decode_output(&dims, data, lb, confidence)?;
            // Offset tile-local boxes to canvas coordinates.
            all.extend(dets.into_iter().map(|mut d| {
                d.x1 += tile.x as f32;
                d.x2 += tile.x as f32;
                d.y1 += tile.y as f32;
                d.y2 += tile.y as f32;
                d
            }));
        }

        let mut result = finalize(all, canvas.width(), canvas.height(), spec.labels);

        // Second stage: name each detected box's element type. Best-effort
        // — a typer failure keeps the detector labels rather than losing
        // the whole detection.
        let typed = if let Some(typer) = model.typer.as_mut() {
            if result.is_empty() {
                false
            } else if let Err(e) = classify_objects(typer, canvas, &mut result) {
                tracing::warn!(model = spec.id, error = %e, "typing failed; keeping detector labels");
                false
            } else {
                true
            }
        } else {
            false
        };

        tracing::debug!(
            model = spec.id,
            tiles = tiles.len(),
            detections = result.len(),
            typed,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "object detection complete"
        );
        Ok(result)
    }
}

fn build_session(model_path: &Path) -> AppResult<Session> {
    if !model_path.is_file() {
        return Err(AppError::Vision(format!(
            "model file missing: {}",
            model_path.display()
        )));
    }
    let threads = std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(1, 4))
        .unwrap_or(2);
    let err = |e: &dyn std::fmt::Display| AppError::Vision(format!("load model: {e}"));
    Session::builder()
        .map_err(|e| err(&e))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| err(&e))?
        .with_intra_threads(threads)
        .map_err(|e| err(&e))?
        .commit_from_file(model_path)
        .map_err(|e| err(&e))
}

/// Build the typer session for a typed model. `Ok(None)` for a
/// detection-only model, or when the typer artifact is absent (logged,
/// then detection-only) — `Err` only on a corrupt/unloadable typer.
fn build_typer(spec: &ModelSpec, typer_path: Option<&Path>) -> AppResult<Option<LoadedTyper>> {
    let Some(t) = spec.typer else {
        return Ok(None);
    };
    let Some(path) = typer_path.filter(|p| p.is_file()) else {
        tracing::warn!(
            model = spec.id,
            "typer artifact missing; running detection-only"
        );
        return Ok(None);
    };
    let session = build_session(path)?;
    let input_name = session
        .inputs()
        .first()
        .map(|i| i.name().to_string())
        .ok_or_else(|| AppError::Vision("typer has no inputs".into()))?;
    let output_name = session
        .outputs()
        .first()
        .map(|o| o.name().to_string())
        .ok_or_else(|| AppError::Vision("typer has no outputs".into()))?;
    Ok(Some(LoadedTyper {
        input_name,
        output_name,
        input_size: t.input_size,
        crop_pad: t.crop_pad,
        labels: t.labels,
        session,
    }))
}

/// Name each detection's element type in place: crop → square-letterbox →
/// the typer → argmax → label. Batched at `TYPER_BATCH` crops per
/// inference to bound peak memory.
fn classify_objects(
    typer: &mut LoadedTyper,
    canvas: &RgbaImage,
    objects: &mut [DetectedObject],
) -> AppResult<()> {
    let input = typer.input_size as usize;
    let per = 3 * input * input;
    for chunk in objects.chunks_mut(TYPER_BATCH) {
        let n = chunk.len();
        let mut batch = vec![0f32; n * per];
        for (i, obj) in chunk.iter().enumerate() {
            let crop = preprocess_crop(canvas, obj.rect, typer.crop_pad, typer.input_size);
            batch[i * per..(i + 1) * per].copy_from_slice(&crop);
        }
        let tensor = Tensor::from_array(([n, 3, input, input], batch))
            .map_err(|e| AppError::Vision(format!("typer input tensor: {e}")))?;
        let outputs = typer
            .session
            .run(ort::inputs![typer.input_name.as_str() => tensor])
            .map_err(|e| AppError::Vision(format!("typer inference: {e}")))?;
        let output = outputs
            .get(typer.output_name.as_str())
            .ok_or_else(|| AppError::Vision("typer output missing".into()))?;
        let (shape, data) = output
            .try_extract_tensor::<f32>()
            .map_err(|e| AppError::Vision(format!("typer output tensor: {e}")))?;
        // Expect logits `[n, classes]`.
        let dims: Vec<usize> = shape.iter().map(|d| *d as usize).collect();
        let classes = match dims.as_slice() {
            [rows, c] if *rows == n && *c >= 1 => *c,
            other => {
                return Err(AppError::Vision(format!(
                    "unexpected typer output shape: {other:?}"
                )))
            }
        };
        for (i, obj) in chunk.iter_mut().enumerate() {
            let row = &data[i * classes..(i + 1) * classes];
            if let Some(label) = typer.labels.get(argmax(row)) {
                obj.label = (*label).to_string();
            }
        }
    }
    Ok(())
}

/// Crop `rect` (padded by `pad`) out of `canvas`, paste it onto a neutral
/// grey square (preserving aspect — a wide slider vs a square checkbox is
/// informative), resize to `input × input`, and return ImageNet-normalized
/// CHW f32 data. Mirrors the typer's training transform.
fn preprocess_crop(canvas: &RgbaImage, rect: Region, pad: f32, input: u32) -> Vec<f32> {
    let (cw_canvas, ch_canvas) = (canvas.width() as f32, canvas.height() as f32);
    let (x, y) = (rect.x as f32, rect.y as f32);
    let (w, h) = (rect.width as f32, rect.height as f32);
    let (dx, dy) = (w * pad, h * pad);
    let x1 = (x - dx).max(0.0) as u32;
    let y1 = (y - dy).max(0.0) as u32;
    let x2 = (x + w + dx).min(cw_canvas) as u32;
    let y2 = (y + h + dy).min(ch_canvas) as u32;
    let crop = image::imageops::crop_imm(
        canvas,
        x1,
        y1,
        x2.saturating_sub(x1).max(1),
        y2.saturating_sub(y1).max(1),
    )
    .to_image();

    // Pad to a square on neutral grey, content centered.
    let (cw, ch) = (crop.width(), crop.height());
    let s = cw.max(ch).max(1);
    let mut square =
        image::RgbImage::from_pixel(s, s, image::Rgb([TYPER_PAD, TYPER_PAD, TYPER_PAD]));
    let (off_x, off_y) = ((s - cw) / 2, (s - ch) / 2);
    for (px, py, p) in crop.enumerate_pixels() {
        square.put_pixel(px + off_x, py + off_y, image::Rgb([p[0], p[1], p[2]]));
    }
    let resized =
        image::imageops::resize(&square, input, input, image::imageops::FilterType::Triangle);

    let n = (input * input) as usize;
    let mut data = vec![0f32; 3 * n];
    for (px, py, p) in resized.enumerate_pixels() {
        let idx = (py * input + px) as usize;
        for c in 0..3 {
            data[c * n + idx] = ((p[c] as f32 / 255.0) - TYPER_MEAN[c]) / TYPER_STD[c];
        }
    }
    data
}

/// Index of the largest element (first on ties); 0 for an empty slice.
fn argmax(row: &[f32]) -> usize {
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    for (i, &v) in row.iter().enumerate() {
        if v > best_v {
            best_v = v;
            best = i;
        }
    }
    best
}

/// Read a detector's declared square input edge from its input
/// `ValueType` — thin glue over [`square_input_from_dims`].
fn declared_input_size(ty: &ValueType) -> Option<u32> {
    match ty {
        ValueType::Tensor { shape, .. } => square_input_from_dims(shape),
        _ => None,
    }
}

/// Pure: extract the square input edge from an NCHW shape `[_, _, H, W]`
/// with `H == W > 0`. Returns `None` for any other rank, a non-square
/// input, or a dynamic (`-1`) spatial dimension — the caller then falls
/// back to the registry's `input_size`.
fn square_input_from_dims(dims: &[i64]) -> Option<u32> {
    if dims.len() == 4 {
        let (h, w) = (dims[2], dims[3]);
        if h > 0 && h == w {
            return u32::try_from(h).ok();
        }
    }
    None
}

/// Crop `tile` out of `canvas`, letterbox-resize into a square
/// `input × input` RGB canvas (gray padding), return CHW-ordered,
/// 0–1-normalized f32 data.
fn preprocess_tile(canvas: &RgbaImage, tile: Region, input: u32, lb: Letterbox) -> Vec<f32> {
    let crop =
        image::imageops::crop_imm(canvas, tile.x, tile.y, tile.width, tile.height).to_image();
    let scaled_w = ((tile.width as f32 * lb.scale).round() as u32).max(1);
    let scaled_h = ((tile.height as f32 * lb.scale).round() as u32).max(1);
    let resized = image::imageops::resize(
        &crop,
        scaled_w,
        scaled_h,
        image::imageops::FilterType::Triangle,
    );

    let n = (input * input) as usize;
    let mut data = vec![PAD_VALUE; 3 * n];
    let (off_x, off_y) = (lb.pad_x.round() as u32, lb.pad_y.round() as u32);
    for (px, py, pixel) in resized.enumerate_pixels() {
        let x = px + off_x;
        let y = py + off_y;
        if x >= input || y >= input {
            continue;
        }
        let idx = (y * input + x) as usize;
        data[idx] = pixel[0] as f32 / 255.0;
        data[n + idx] = pixel[1] as f32 / 255.0;
        data[2 * n + idx] = pixel[2] as f32 / 255.0;
    }
    data
}

/// Dispatch on output shape: `[1, N, 6]` end-to-end vs `[1, 4+C, A]`
/// raw (channels < anchors disambiguates — a raw head always has far
/// more anchors than channels).
fn decode_output(
    dims: &[usize],
    data: &[f32],
    lb: Letterbox,
    confidence: f32,
) -> AppResult<Vec<RawDetection>> {
    match dims {
        [1, rows, 6] => Ok(decode_e2e(data, *rows, lb, confidence)),
        [1, channels, anchors] if *channels >= 5 && channels < anchors => {
            Ok(decode_raw(data, *channels, *anchors, lb, confidence))
        }
        other => Err(AppError::Vision(format!(
            "unsupported detector output shape: {other:?}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preprocess_letterboxes_wide_tile_with_gray_pads() {
        // A solid-red 100×50 canvas letterboxed into a 64-px input:
        // content occupies rows 16..48 after the vertical pad.
        let canvas = RgbaImage::from_pixel(100, 50, image::Rgba([255, 0, 0, 255]));
        let tile = Region {
            x: 0,
            y: 0,
            width: 100,
            height: 50,
        };
        let lb = Letterbox::fit(100, 50, 64);
        let data = preprocess_tile(&canvas, tile, 64, lb);
        assert_eq!(data.len(), 3 * 64 * 64);

        let n = 64 * 64;
        let at = |c: usize, x: usize, y: usize| data[c * n + y * 64 + x];
        // Center of content: red channel ≈ 1.0, green/blue ≈ 0.
        assert!(at(0, 32, 32) > 0.95, "content R");
        assert!(at(1, 32, 32) < 0.05, "content G");
        // Top pad row: all channels at the 114-gray pad value.
        assert!((at(0, 32, 2) - PAD_VALUE).abs() < 1e-6, "pad R");
        assert!((at(2, 32, 2) - PAD_VALUE).abs() < 1e-6, "pad B");
    }

    #[test]
    fn decode_output_dispatches_by_shape() {
        let lb = Letterbox::fit(640, 640, 640);
        // e2e shape [1, 1, 6].
        let e2e = [0.0f32, 0.0, 100.0, 100.0, 0.9, 2.0];
        let dets = decode_output(&[1, 1, 6], &e2e, lb, 0.5).unwrap();
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].class_id, 2);

        // raw shape [1, 5, 8] (1 class, 8 anchors) — all below threshold.
        let raw = vec![0.0f32; 5 * 8];
        let dets = decode_output(&[1, 5, 8], &raw, lb, 0.5).unwrap();
        assert!(dets.is_empty());

        // unsupported rank.
        assert!(decode_output(&[1, 6], &e2e, lb, 0.5).is_err());
    }

    #[test]
    fn square_input_from_dims_reads_nchw_and_rejects_the_rest() {
        // Square NCHW → the edge.
        assert_eq!(square_input_from_dims(&[1, 3, 640, 640]), Some(640));
        assert_eq!(square_input_from_dims(&[1, 3, 1280, 1280]), Some(1280));
        // Dynamic spatial dims (-1) → fall back (None).
        assert_eq!(square_input_from_dims(&[1, 3, -1, -1]), None);
        // Non-square → None (we only letterbox into a square input).
        assert_eq!(square_input_from_dims(&[1, 3, 480, 640]), None);
        // Wrong rank → None.
        assert_eq!(square_input_from_dims(&[3, 640, 640]), None);
        assert_eq!(square_input_from_dims(&[640, 640]), None);
    }

    #[test]
    fn release_is_a_safe_noop_when_no_session_is_cached() {
        let svc = VisionService::new();
        // Nothing loaded yet → nothing to free, and it must not panic or
        // wedge the lock for a subsequent call.
        assert!(!svc.release());
        assert!(!svc.release());
    }

    #[test]
    fn detect_errors_cleanly_when_model_file_is_missing() {
        let svc = VisionService::new();
        let canvas = RgbaImage::new(64, 64);
        let spec = clippity_domain::models::find("yolov10n").unwrap();
        let err = svc
            .detect(
                &canvas,
                spec,
                Path::new("Z:/does/not/exist.onnx"),
                None,
                0.25,
            )
            .unwrap_err();
        assert_eq!(err.code(), "vision");
    }

    #[test]
    fn preprocess_crop_normalizes_imagenet_and_sizes_chw() {
        // A solid-red square crop (no padding) → every pixel is red,
        // ImageNet-normalized, laid out CHW.
        let canvas = RgbaImage::from_pixel(32, 32, image::Rgba([255, 0, 0, 255]));
        let rect = Region {
            x: 0,
            y: 0,
            width: 32,
            height: 32,
        };
        let input = 8u32;
        let data = preprocess_crop(&canvas, rect, 0.0, input);
        assert_eq!(data.len(), 3 * (input * input) as usize);

        let n = (input * input) as usize;
        let at = |c: usize, x: usize, y: usize| data[c * n + y * input as usize + x];
        let chan = |v: f32, c: usize| (v - TYPER_MEAN[c]) / TYPER_STD[c];
        assert!((at(0, 4, 4) - chan(1.0, 0)).abs() < 1e-3, "R");
        assert!((at(1, 4, 4) - chan(0.0, 1)).abs() < 1e-3, "G");
        assert!((at(2, 4, 4) - chan(0.0, 2)).abs() < 1e-3, "B");
    }

    #[test]
    fn preprocess_crop_letterboxes_wide_crop_with_grey() {
        // A wide (40×10) red crop pads to a square with grey above/below.
        let canvas = RgbaImage::from_pixel(40, 10, image::Rgba([255, 0, 0, 255]));
        let rect = Region {
            x: 0,
            y: 0,
            width: 40,
            height: 10,
        };
        let input = 8u32;
        let data = preprocess_crop(&canvas, rect, 0.0, input);
        let n = (input * input) as usize;
        let at = |c: usize, x: usize, y: usize| data[c * n + y * input as usize + x];

        let grey_r = (TYPER_PAD as f32 / 255.0 - TYPER_MEAN[0]) / TYPER_STD[0];
        // Top row is grey pad; the centered band is the red content —
        // distinctly redder than the pad (exact value blurs at the band
        // edge under the resize filter, so assert the relationship).
        assert!(
            (at(0, 4, 0) - grey_r).abs() < 0.15,
            "top grey R = {}",
            at(0, 4, 0)
        );
        assert!(
            at(0, 4, 4) > grey_r + 1.0,
            "center red R = {} (pad {})",
            at(0, 4, 4),
            grey_r
        );
    }

    #[test]
    fn argmax_picks_largest_first_on_ties() {
        assert_eq!(argmax(&[0.1, 0.9, 0.3]), 1);
        assert_eq!(argmax(&[2.0, 2.0, 1.0]), 0);
        assert_eq!(argmax(&[]), 0);
    }
}
