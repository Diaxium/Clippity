//! Draws a session's sources over its captured frames (ADR 0033).
//!
//! The pure arithmetic — placement, alpha, backdrops — is
//! `domain::composition`. What lives here is the I/O half: opening a
//! camera or an image file, keeping the camera on its own thread, and
//! knowing *when* to blend.
//!
//! **Two entry points, because the frame loop writes frames two ways.**
//! A freshly grabbed frame is composited once, at grab
//! ([`Compositor::draw`]). A *held* frame — the one re-written in place
//! every `MAX_HELD_MS` while the screen is motionless (ADR 0031) — is
//! restored to its captured pixels and blended again
//! ([`Compositor::redraw`]), which is what keeps a webcam moving while
//! the screen is still and stops a semi-transparent source compounding
//! over its own output.
//!
//! **Every failure degrades to not drawing.** A camera another app holds,
//! an image the user deleted, a device unplugged mid-session: none of
//! them may end a recording. Same rule ADR 0031 set for audio — the
//! screen content is what the user came for.

use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc,
};
use std::thread::JoinHandle;

use clippity_domain::composition::{self, Placement, Source, SourceFrame, SourceKind};
use clippity_domain::pixels::PixelOrder;

/// How long a camera thread waits before retrying after a read that
/// produced nothing. A camera delivers on its own cadence; polling
/// tighter than this burns a core to learn the same thing.
const CAMERA_IDLE: std::time::Duration = std::time::Duration::from_millis(5);

/// Where an open source's pixels come from.
enum Feed {
    /// Decoded once at open, re-aligned only if the capture's channel
    /// order changes under it.
    Still {
        pixels: Vec<u8>,
        width: u32,
        height: u32,
        order: PixelOrder,
    },
    /// Fed by a camera thread. `latest` holds the most recent delivery,
    /// which is what gets blended — a camera that stalls leaves the
    /// previous image up rather than stalling the recording.
    Camera {
        rx: Receiver<CameraFrame>,
        latest: Option<CameraFrame>,
        stop: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    },
}

struct CameraFrame {
    pixels: Vec<u8>,
    width: u32,
    height: u32,
}

struct OpenSource {
    feed: Feed,
    place: Placement,
    opacity_pct: u16,
    /// The capture's own pixels under this source, saved on the last
    /// [`Compositor::draw`]. Empty until then — a `redraw` with nothing
    /// saved does nothing rather than painting stale pixels over a fresh
    /// frame.
    backdrop: Vec<u8>,
}

/// A session's open sources.
pub struct Compositor {
    sources: Vec<OpenSource>,
    /// The channel order the sources are currently aligned to.
    ///
    /// **Not fixed for a session.** `FrameSource` can fall back from
    /// a held Desktop Duplication (BGRA) to per-call grabs (RGBA)
    /// partway through — a resolution change, a full-screen app, a
    /// lock screen — and a source aligned to the old order would swap
    /// red and blue from that moment on. So the order travels with
    /// each frame and the sources follow it.
    aligned: PixelOrder,
    /// Shared with the camera threads, which align their own
    /// deliveries. An atomic because they read it per delivered frame,
    /// on their own thread, while this one may be changing it.
    want: Arc<AtomicU8>,
}

/// `PixelOrder` as the byte a camera thread reads it back as.
fn order_code(order: PixelOrder) -> u8 {
    match order {
        PixelOrder::Bgra => 0,
        PixelOrder::Rgba => 1,
    }
}

fn order_from_code(code: u8) -> PixelOrder {
    if code == 0 {
        PixelOrder::Bgra
    } else {
        PixelOrder::Rgba
    }
}

impl Compositor {
    /// Open every drawable source for a frame of `frame_w × frame_h` in
    /// `order`.
    ///
    /// Sources that fail to open are logged and dropped, so a session
    /// with a broken camera still records — and one with no working
    /// sources costs the frame loop a single `is_empty` check.
    pub fn open(sources: &[Source], frame_w: u32, frame_h: u32, order: PixelOrder) -> Self {
        let want = Arc::new(AtomicU8::new(order_code(order)));
        let mut open = Vec::new();
        for source in sources {
            let Some(place) = composition::placement(source, frame_w, frame_h) else {
                continue;
            };
            match open_feed(&source.kind, order, &want) {
                Ok(feed) => open.push(OpenSource {
                    feed,
                    place,
                    opacity_pct: source.opacity_pct,
                    backdrop: Vec::new(),
                }),
                Err(e) => tracing::warn!("a recording source did not open: {e}"),
            }
        }
        Self {
            sources: open,
            aligned: order,
            want,
        }
    }

    /// Follow the capture's channel order if it has changed.
    ///
    /// Cheap and almost always a no-op: the comparison is two bytes,
    /// and a re-align costs one pass over each *source* — the small
    /// buffer, not the frame.
    fn align_to(&mut self, order: PixelOrder) {
        if self.aligned == order {
            return;
        }
        tracing::debug!("capture channel order changed; re-aligning sources");
        self.want.store(order_code(order), Ordering::Relaxed);
        for source in &mut self.sources {
            source.align_to(order);
        }
        self.aligned = order;
    }

    pub fn is_empty(&self) -> bool {
        self.sources.is_empty()
    }

    /// Composite over a **freshly captured** frame: remember what each
    /// source covers, then draw.
    pub fn draw(&mut self, frame: &mut [u8], frame_w: u32, frame_h: u32, order: PixelOrder) {
        self.align_to(order);
        for source in &mut self.sources {
            source.pull();
            if !composition::save_backdrop(frame, frame_w, &source.place, &mut source.backdrop) {
                // The frame and the placement disagree — a geometry bug,
                // not something to paint over. Skipping leaves the
                // capture intact.
                continue;
            }
            source.blend(frame, frame_w, frame_h);
        }
    }

    /// Composite over a frame that was **already drawn on**: put the
    /// capture back, then draw again with whatever the camera has now.
    ///
    /// Without the restore, a held frame's overlay would freeze and a
    /// semi-transparent one would darken on every re-write — see
    /// `domain::composition::save_backdrop`.
    pub fn redraw(&mut self, frame: &mut [u8], frame_w: u32, frame_h: u32, order: PixelOrder) {
        self.align_to(order);
        for source in &mut self.sources {
            if source.backdrop.is_empty() {
                continue;
            }
            source.pull();
            if !composition::restore_backdrop(frame, frame_w, &source.place, &source.backdrop) {
                continue;
            }
            source.blend(frame, frame_w, frame_h);
        }
    }
}

impl OpenSource {
    /// Re-align this source's pixels to a new capture order.
    ///
    /// A camera feed needs nothing ongoing here — its thread reads
    /// the shared `want` and aligns each delivery — but the frame
    /// already in hand is in the old order, so it is swapped too
    /// rather than showing one wrong frame at the seam.
    fn align_to(&mut self, order: PixelOrder) {
        match &mut self.feed {
            Feed::Still {
                pixels,
                order: have,
                ..
            } => {
                composition::align_order(pixels, *have, order);
                *have = order;
            }
            Feed::Camera { latest, .. } => {
                if let Some(frame) = latest {
                    composition::align_order(&mut frame.pixels, order.swapped(), order);
                }
            }
        }
    }

    /// Take the newest camera frame, if one has arrived.
    fn pull(&mut self) {
        if let Feed::Camera { rx, latest, .. } = &mut self.feed {
            // Drain rather than take one: the camera may have delivered
            // several since the last recorded frame, and the newest is
            // the only one anybody wants to see.
            loop {
                match rx.try_recv() {
                    Ok(frame) => *latest = Some(frame),
                    Err(TryRecvError::Empty) => break,
                    // The thread ended — keep showing the last frame
                    // rather than blanking the overlay.
                    Err(TryRecvError::Disconnected) => break,
                }
            }
        }
    }

    fn blend(&self, frame: &mut [u8], frame_w: u32, frame_h: u32) {
        let src = match &self.feed {
            Feed::Still {
                pixels,
                width,
                height,
                ..
            } => SourceFrame {
                pixels,
                width: *width,
                height: *height,
            },
            Feed::Camera { latest, .. } => match latest {
                Some(f) => SourceFrame {
                    pixels: &f.pixels,
                    width: f.width,
                    height: f.height,
                },
                // Nothing delivered yet. The backdrop was saved and not
                // painted over, so the capture shows through.
                None => return,
            },
        };
        composition::blend(frame, frame_w, frame_h, &self.place, src, self.opacity_pct);
    }
}

impl Drop for Feed {
    fn drop(&mut self) {
        if let Feed::Camera { stop, worker, .. } = self {
            stop.store(true, Ordering::Relaxed);
            if let Some(handle) = worker.take() {
                // Joined rather than detached: the thread holds COM
                // objects, and letting it outlive the session would keep
                // the camera's light on after the recording stopped.
                let _ = handle.join();
            }
        }
    }
}

fn open_feed(kind: &SourceKind, order: PixelOrder, want: &Arc<AtomicU8>) -> Result<Feed, String> {
    match kind {
        SourceKind::Image { path } => open_still(path, order),
        SourceKind::Webcam { device_id } => open_camera(device_id.as_deref(), want),
    }
}

/// Decode an image once and align its channels to the capture's order.
fn open_still(path: &str, order: PixelOrder) -> Result<Feed, String> {
    let image = image::open(path).map_err(|e| format!("{path}: {e}"))?;
    let rgba = image.to_rgba8();
    let (width, height) = (rgba.width(), rgba.height());
    let mut pixels = rgba.into_raw();
    // Once, at open — the per-frame cost is then a straight blend.
    composition::align_order(&mut pixels, PixelOrder::Rgba, order);
    Ok(Feed::Still {
        pixels,
        width,
        height,
        order,
    })
}

#[cfg(target_os = "windows")]
fn open_camera(device_id: Option<&str>, want: &Arc<AtomicU8>) -> Result<Feed, String> {
    use clippity_platform::windows::media_foundation::ComThread;
    use clippity_platform::windows::webcam::Webcam;

    let (tx, rx) = std::sync::mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let device = device_id.map(str::to_string);
    let thread_stop = Arc::clone(&stop);
    let thread_want = Arc::clone(want);

    // The camera is opened *on* its thread, not handed to it: the reader
    // is a COM object, so it has to be created where it will be used.
    let worker = std::thread::spawn(move || {
        let _com = match ComThread::init() {
            Ok(com) => com,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("COM: {e}")));
                return;
            }
        };
        let mut cam = match Webcam::open(device.as_deref()) {
            Ok(cam) => cam,
            Err(e) => {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }
        };
        let from = cam.order();
        let _ = ready_tx.send(Ok(()));

        let mut recycle: Option<Vec<u8>> = None;
        while !thread_stop.load(Ordering::Relaxed) {
            match cam.read(recycle.take()) {
                Ok(Some(mut pixels)) => {
                    // Aligned here, on the camera's thread and at the
                    // camera's rate — a 30 fps camera into a 60 fps
                    // recording pays half as often as a per-recorded-frame
                    // swap would.
                    // Re-read every delivery so a mid-session capture-
                    // order change is picked up without restarting the
                    // camera.
                    let order = order_from_code(thread_want.load(Ordering::Relaxed));
                    composition::align_order(&mut pixels, from, order);
                    let frame = CameraFrame {
                        pixels,
                        width: cam.width(),
                        height: cam.height(),
                    };
                    if tx.send(frame).is_err() {
                        break;
                    }
                }
                Ok(None) => std::thread::sleep(CAMERA_IDLE),
                Err(e) => {
                    // The camera went away mid-session. Stop reading and
                    // leave the last frame up; the recording continues.
                    tracing::warn!("camera stopped delivering: {e}");
                    break;
                }
            }
        }
    });

    // Wait for the open to succeed or fail before the session starts, so
    // a broken camera is a log line at start rather than an overlay that
    // never appears.
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(Feed::Camera {
            rx,
            latest: None,
            stop,
            worker: Some(worker),
        }),
        Ok(Err(e)) => {
            let _ = worker.join();
            Err(e)
        }
        Err(_) => {
            let _ = worker.join();
            Err("the camera thread ended before opening".into())
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn open_camera(_device_id: Option<&str>, _want: &Arc<AtomicU8>) -> Result<Feed, String> {
    Err("webcam capture requires Windows Media Foundation".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clippity_domain::annotation::NormRect;

    fn still_source(path: &str) -> Source {
        Source {
            kind: SourceKind::Image { path: path.into() },
            rect: NormRect {
                x: 0.0,
                y: 0.0,
                w: 0.5,
                h: 0.5,
            },
            opacity_pct: 100,
            enabled: true,
        }
    }

    #[test]
    fn a_source_that_cannot_open_is_dropped_not_fatal() {
        // The degradation rule: a deleted image must not cost the user
        // their recording.
        let c = Compositor::open(
            &[still_source("C:\\definitely\\not\\here.png")],
            100,
            100,
            PixelOrder::Bgra,
        );
        assert!(c.is_empty());
    }

    #[test]
    fn a_disabled_source_is_not_opened_at_all() {
        let mut s = still_source("C:\\whatever.png");
        s.enabled = false;
        let c = Compositor::open(&[s], 100, 100, PixelOrder::Bgra);
        assert!(c.is_empty());
    }

    #[test]
    fn an_empty_compositor_leaves_a_frame_untouched() {
        let mut c = Compositor::open(&[], 4, 4, PixelOrder::Bgra);
        let mut frame = vec![7u8; 4 * 4 * 4];
        let before = frame.clone();
        c.draw(&mut frame, 4, 4, PixelOrder::Rgba);
        c.redraw(&mut frame, 4, 4, PixelOrder::Rgba);
        assert_eq!(frame, before);
    }

    #[test]
    fn a_still_source_draws_and_redraws_identically() {
        // The held-frame guarantee, end to end through the service half
        // rather than only the domain blend.
        let dir =
            std::env::temp_dir().join(format!("clippity-src-{}", crate::capture_io::next_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("logo.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 255, 255, 128]))
            .save(&path)
            .unwrap();

        let source = still_source(path.to_str().unwrap());
        let mut c = Compositor::open(&[source], 4, 4, PixelOrder::Rgba);
        assert!(!c.is_empty(), "the image source should have opened");

        let mut frame = vec![0u8; 4 * 4 * 4];
        c.draw(&mut frame, 4, 4, PixelOrder::Rgba);
        let after_draw = frame.clone();

        for _ in 0..5 {
            c.redraw(&mut frame, 4, 4, PixelOrder::Rgba);
        }
        assert_eq!(frame, after_draw, "redraw drifted from the first draw");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn redraw_before_any_draw_does_nothing() {
        // No backdrop has been saved, so there is nothing to restore —
        // and restoring stale pixels over a fresh frame would be worse
        // than not drawing.
        let dir =
            std::env::temp_dir().join(format!("clippity-src2-{}", crate::capture_io::next_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("logo.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([9, 9, 9, 255]))
            .save(&path)
            .unwrap();

        let mut c = Compositor::open(
            &[still_source(path.to_str().unwrap())],
            4,
            4,
            PixelOrder::Rgba,
        );
        let mut frame = vec![3u8; 4 * 4 * 4];
        let before = frame.clone();
        c.redraw(&mut frame, 4, 4, PixelOrder::Rgba);
        assert_eq!(frame, before);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
