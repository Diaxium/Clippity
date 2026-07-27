//! Native benchmark suite — performance roadmap P2.
//!
//! Each `bench_function` id here has a matching row in
//! `backend/benches-budgets.toml`; `scripts/check-bench-budgets.mjs`
//! reads Criterion's `estimates.json` for these ids and gates the median
//! against the budget. Keep the ids and the budget keys in sync.
//!
//! Scope: the CPU/IO-bound native work a capture actually spends time in
//! — scroll stitching, still (PNG) encode, thumbnail generation and the
//! library index at 50k rows. App-lifecycle metrics (cold/warm startup,
//! hotkey-to-overlay, OCR, idle CPU/RAM, installer size) need a running
//! app or a model on disk; they are tracked as non-automated budgets in
//! the same manifest until a native driver lands.

use std::io::Cursor;
use std::time::Duration;

use criterion::{black_box, criterion_group, criterion_main, Criterion};

use clippity_bench::{library_corpus, scroll_corpus, synthetic_frame};
use clippity_domain::scroll;
use clippity_services::capture_io::thumbnail_data_uri;
use clippity_services::library_index::{FacetsQuery, LibraryIndex, LibraryQuery};
use image::{DynamicImage, ImageFormat};

/// Frames the scroll worker typically accumulates for a full-page grab.
const SCROLL_FRAMES: usize = 24;
const SCROLL_W: u32 = 1280;
const SCROLL_H: u32 = 400;
const SCROLL_STEP: i32 = 320;

/// A 4K still — the reference size the roadmap's save budget names.
const STILL_W: u32 = 3840;
const STILL_H: u32 = 2160;
const THUMB_EDGE: u32 = 320;

/// Library scale the roadmap targets for search/list budgets.
const LIBRARY_ROWS: usize = 50_000;

fn bench_scroll_stitch(c: &mut Criterion) {
    let (frames, offsets) = scroll_corpus(SCROLL_FRAMES, SCROLL_W, SCROLL_H, SCROLL_STEP);
    let mut g = c.benchmark_group("scroll_stitch");
    g.sample_size(30);
    g.bench_function("stitch_24x1280x400", |b| {
        b.iter(|| scroll::stitch(black_box(&frames), black_box(&offsets)))
    });
    g.finish();
}

fn bench_still_encode(c: &mut Criterion) {
    let img = synthetic_frame(STILL_W, STILL_H, 42);
    let mut g = c.benchmark_group("still_encode");
    g.sample_size(20);
    g.measurement_time(Duration::from_secs(6));
    g.bench_function("png_encode_4k", |b| {
        b.iter(|| {
            let mut buf = Vec::new();
            DynamicImage::ImageRgba8(black_box(img.clone()))
                .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
                .unwrap();
            buf
        })
    });
    g.finish();
}

fn bench_thumbnail(c: &mut Criterion) {
    let img = synthetic_frame(STILL_W, STILL_H, 42);
    let mut g = c.benchmark_group("thumbnail");
    g.sample_size(20);
    g.bench_function("thumb_4k_to_320", |b| {
        b.iter(|| thumbnail_data_uri(black_box(&img), THUMB_EDGE))
    });
    g.finish();
}

fn bench_library(c: &mut Criterion) {
    let corpus = library_corpus(LIBRARY_ROWS);

    // Insert 50k rows into a fresh in-memory index each iteration.
    {
        let mut g = c.benchmark_group("library_put");
        g.sample_size(10);
        g.measurement_time(Duration::from_secs(10));
        g.bench_function("put_50k", |b| {
            b.iter_batched(
                || LibraryIndex::in_memory().unwrap(),
                |index| index.put(black_box(&corpus)).unwrap(),
                criterion::BatchSize::SmallInput,
            )
        });
        g.finish();
    }

    // Read paths run against one pre-populated index (the list/reconcile
    // work the library does on every open).
    let index = LibraryIndex::in_memory().unwrap();
    index.put(&corpus).unwrap();

    {
        let mut g = c.benchmark_group("library_rows");
        g.sample_size(20);
        g.bench_function("rows_50k", |b| {
            b.iter(|| black_box(index.rows(black_box(false)).unwrap()))
        });
        g.finish();
    }

    {
        let mut g = c.benchmark_group("library_stamps");
        g.sample_size(20);
        g.bench_function("stamps_50k", |b| {
            b.iter(|| black_box(index.stamps().unwrap()))
        });
        g.finish();
    }

    // The P5 pushdown: fetching one page — and searching — over 50k rows
    // without materializing the whole listing (contrast library_rows).
    {
        let mut g = c.benchmark_group("library_query");
        g.sample_size(20);
        g.bench_function("page_50", |b| {
            b.iter(|| {
                let q = LibraryQuery { limit: Some(50), ..Default::default() };
                black_box(index.query(black_box(&q)).unwrap())
            })
        });
        g.bench_function("search_50k", |b| {
            b.iter(|| {
                let q = LibraryQuery {
                    search: Some("review".into()),
                    limit: Some(50),
                    ..Default::default()
                };
                black_box(index.query(black_box(&q)).unwrap())
            })
        });
        g.finish();
    }

    // The other half of P5: every count the destination rail shows, which
    // a page cannot answer. This is what the client used to derive by
    // loading all 50k rows (contrast library_rows) purely to label its
    // own navigation.
    {
        let mut g = c.benchmark_group("library_facets");
        g.sample_size(20);
        g.bench_function("facets_50k", |b| {
            b.iter(|| {
                let q = FacetsQuery {
                    this_week_since_ms: 1_700_000_000_000,
                    last_30_days_since_ms: 1_600_000_000_000,
                    large_min_bytes: 5 * 1024 * 1024,
                };
                black_box(index.facets(black_box(&q)).unwrap())
            })
        });
        g.finish();
    }
}

/// The desktop sizes the overlay handoff has to carry: this class of
/// laptop panel, and the 4K case the loupe comments describe.
const DESK_HD_W: u32 = 1920;
const DESK_HD_H: u32 = 1200;
const DESK_4K_W: u32 = 3840;
const DESK_4K_H: u32 = 2160;

/// What `overlay_service::show` does between the desktop grab and the
/// magnifier being usable — measured piece by piece, because the pieces
/// are on two different critical paths.
///
/// `clone` and the encode sit *before* the overlay can be used: the
/// snapshot is the overlay's own backdrop as well as the loupe's sample
/// source, so until the payload lands the user is looking at a dim sheet
/// with no magnifier. Splitting `encode` from `base64` is the point of
/// the exercise — the base64 half exists only because the payload
/// travels as a data URI through the IPC bridge.
fn bench_overlay_handoff(c: &mut Criterion) {
    for (label, w, h) in [
        ("1920x1200", DESK_HD_W, DESK_HD_H),
        ("4k", DESK_4K_W, DESK_4K_H),
    ] {
        let canvas = synthetic_frame(w, h, 7);
        let mut g = c.benchmark_group("overlay_handoff");
        g.sample_size(20);
        g.measurement_time(Duration::from_secs(6));

        // `show` keeps one copy in session state and hands another to the
        // encoder thread — a full-desktop RGBA memcpy on the critical path.
        g.bench_function(format!("clone_{label}"), |b| {
            b.iter(|| black_box(black_box(&canvas).clone()))
        });

        // The encode exactly as `render_loupe_data_uri` runs it.
        g.bench_function(format!("png_fast_{label}"), |b| {
            b.iter(|| black_box(encode_loupe_png(black_box(&canvas))))
        });

        // The base64 wrapper on top — pure cost of shipping it as a data
        // URI rather than as bytes over a URL.
        let png = encode_loupe_png(&canvas);
        g.bench_function(format!("base64_{label}"), |b| {
            b.iter(|| black_box(to_data_uri(black_box(&png))))
        });

        g.finish();
    }
}

/// `overlay_service::render_loupe_data_uri`'s encoder settings, mirrored
/// so the bench measures the same work the overlay actually does.
fn encode_loupe_png(canvas: &image::RgbaImage) -> Vec<u8> {
    use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
    use image::{ExtendedColorType, ImageEncoder};

    let mut bytes = Vec::new();
    PngEncoder::new_with_quality(
        Cursor::new(&mut bytes),
        CompressionType::Fast,
        PngFilter::NoFilter,
    )
    .write_image(
        canvas.as_raw(),
        canvas.width(),
        canvas.height(),
        ExtendedColorType::Rgba8,
    )
    .unwrap();
    bytes
}

fn to_data_uri(png: &[u8]) -> String {
    use base64::Engine;
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    )
}

criterion_group!(
    benches,
    bench_scroll_stitch,
    bench_still_encode,
    bench_thumbnail,
    bench_library,
    bench_overlay_handoff,
);
criterion_main!(benches);
