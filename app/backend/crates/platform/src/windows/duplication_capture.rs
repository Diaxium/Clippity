//! A capture session that stays open, for recording.
//!
//! Every other grab in the app is a *one-shot*: a screenshot asks for
//! one image and the machinery to produce it is built and thrown away
//! around that single call. That is the right shape for a screenshot and
//! the wrong shape for a recording, which asks thirty times a second.
//!
//! # What this saves
//!
//! `xcap`'s per-call grab measured **34 ms** on a 5120x1440 output in a
//! release build — and a 30 fps frame budget is 33 ms, so the capture
//! alone overran it before the encoder had seen anything. Almost all of
//! that is setup: a device, a duplication interface and a staging
//! texture, created and destroyed per frame.
//!
//! Holding them open moves that cost out of the loop entirely. What
//! remains per frame is one GPU→CPU copy of the region actually being
//! recorded, which is memory bandwidth and nothing else.
//!
//! # Unchanged frames cost nothing
//!
//! Desktop Duplication delivers on *change*. A still desktop times out
//! rather than handing over an identical copy, and [`Grab::Unchanged`]
//! passes that straight to the caller so a recorder can re-emit the
//! frame it already holds. A screen recording is mostly still, so this
//! is not a micro-optimisation — it is most frames.
//!
//! # Two traps this inherits from `hdr_capture`
//!
//! Both were found the hard way there and apply identically here:
//!
//! - **A metadata-only frame is not a picture.** A fresh duplication
//!   answers its first `AcquireNextFrame` immediately with
//!   `LastPresentTime == 0`, over a surface nothing has been composed
//!   into. Taking it yields a black frame through a path where every
//!   error check passes.
//! - **`RowPitch` is not `width * 4`.** The driver pads rows to its own
//!   alignment, and reading a padded surface as though it were tightly
//!   packed shears the image progressively further right down the frame.
//!
//! # Why the pixels come out BGRA
//!
//! Because that is what duplication produces, and nothing between here
//! and the encoder needs them any other way.
//!
//! This used to swap red and blue on the way out, on the reasoning that
//! the copy out of the mapped surface had to happen regardless so
//! reordering two of every four bytes was free. It was not: a per-pixel
//! loop pushing four bytes at a time onto a `Vec` is nothing like a
//! per-row `copy_from_slice`, and at 5120x1440 the difference is
//! 7.4 million bounds-checked appends against 1440 memcpys. The order
//! now travels with the frame instead (`domain::pixels::PixelOrder`) and
//! the NV12 converter absorbs the swap, which costs it nothing — it
//! reads red and blue through indices either way.

use std::sync::atomic::{AtomicBool, Ordering};

use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication,
    IDXGIResource, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_NOT_FOUND, DXGI_ERROR_WAIT_TIMEOUT,
    DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::Graphics::Gdi::HMONITOR;

/// How long one `AcquireNextFrame` waits.
///
/// Short on purpose. A timeout is the *normal* answer on a still
/// desktop, and the recorder's pacing loop wants control back promptly
/// so it can re-emit the previous frame and keep its cadence, rather
/// than blocking through a frame interval waiting for a change that is
/// not coming.
const ACQUIRE_TIMEOUT_MS: u32 = 4;

/// What one attempt at a frame produced.
pub enum Grab {
    /// New pixels, written into the caller's buffer.
    Fresh,
    /// Nothing has changed on screen. The caller's buffer is untouched
    /// and still holds the last frame, which is what should be encoded.
    Unchanged,
}

/// An open duplication of one output.
pub struct MonitorDuplicator {
    /// Held for its lifetime, not for its methods. The duplication and
    /// the staging texture were both created from this device and are
    /// invalid the moment it is released, so dropping it early would
    /// invalidate the rest of the struct rather than merely tidy up.
    _device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    /// Reused across frames — allocating one per grab is most of what
    /// made the one-shot path expensive.
    staging: ID3D11Texture2D,
    width: u32,
    height: u32,
    /// The output's top-left in virtual-desktop coordinates, so a caller
    /// working in that space can convert to output-local.
    origin: (i32, i32),
}

/// Whether Desktop Duplication may be used at all.
///
/// Backs the `recorder.duplication` developer feature flag. Turning it
/// off makes [`MonitorDuplicator::open`] refuse, which drops the
/// recorder onto its per-call grab path — the fallback it already takes
/// when duplication is unavailable, and the comparison a user needs
/// when a recording tears, stalls, or comes back black.
///
/// A process global for the same reason the HDR path has one: the
/// caller is a private constructor inside the recorder's worker, and
/// threading a preference to it would put a settings dependency on the
/// frame loop for a switch that is on in every ordinary session.
static ENABLED: AtomicBool = AtomicBool::new(true);

/// Arm or disarm the Desktop Duplication capture path.
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// Whether Desktop Duplication is armed.
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

impl MonitorDuplicator {
    /// Open a duplication of the output driving `hmonitor`.
    pub fn open(hmonitor: HMONITOR) -> Result<Self, String> {
        if !enabled() {
            return Err("desktop duplication is turned off by a feature flag".into());
        }
        // SAFETY: a linear DXGI + D3D11 setup. Every interface is
        // reference-counted by `windows` and released on drop.
        unsafe {
            let found = find_output(hmonitor)?;
            let (device, context) = create_device(&found.adapter)?;
            let duplication = found
                .output
                .DuplicateOutput(&device)
                .map_err(|e| format!("desktop duplication refused: {e}"))?;
            let staging = create_staging(&device, found.width, found.height)?;
            let (width, height, origin) = (found.width, found.height, found.origin);
            Ok(Self {
                _device: device,
                context,
                duplication,
                staging,
                width,
                height,
                origin,
            })
        }
    }

    /// Open a duplication of the output under a virtual-desktop point.
    pub fn open_at(x: i32, y: i32) -> Result<Self, String> {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONULL};

        // SAFETY: a by-value POINT and a documented flag.
        let hmonitor = unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONULL) };
        if hmonitor.is_invalid() {
            return Err("no monitor at that point".into());
        }
        Self::open(hmonitor)
    }

    /// The output's origin in virtual-desktop coordinates.
    pub fn origin(&self) -> (i32, i32) {
        self.origin
    }

    /// The output's size in pixels.
    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Whether an output-local rectangle lies wholly on this output.
    pub fn covers(&self, x: u32, y: u32, width: u32, height: u32) -> bool {
        x.saturating_add(width) <= self.width && y.saturating_add(height) <= self.height
    }

    /// Grab the given output-local rectangle as BGRA into `out`.
    ///
    /// `out` is resized to `width * height * 4` and left untouched when
    /// the answer is [`Grab::Unchanged`], so the caller keeps whatever
    /// it held.
    ///
    /// The channel order is the surface's own — see the module note.
    /// Callers that need it stated travel with
    /// [`clippity_domain::pixels::PixelOrder::Bgra`].
    ///
    /// An error means this duplication is finished — most often
    /// `DXGI_ERROR_ACCESS_LOST`, which a resolution change, a full-screen
    /// application taking over, or a session lock all produce. The
    /// caller's recovery is to open a new one, not to fail.
    pub fn grab_bgra(
        &mut self,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        out: &mut Vec<u8>,
    ) -> Result<Grab, String> {
        if !self.covers(x, y, width, height) {
            return Err("the requested region is not on this output".into());
        }

        // SAFETY: the acquire/release pair is balanced on every path
        // below, and the map is unmapped before returning.
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            match self
                .duplication
                .AcquireNextFrame(ACQUIRE_TIMEOUT_MS, &mut info, &mut resource)
            {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(Grab::Unchanged),
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => {
                    return Err(format!("duplication lost: {e}"))
                }
                Err(e) => return Err(format!("frame acquisition failed: {e}")),
            }

            // A frame with nothing presented behind it carries pointer
            // metadata over a surface no desktop image has been composed
            // into — see the module note. Treated as "no change", which
            // is what it is.
            if info.LastPresentTime == 0 {
                let _ = self.duplication.ReleaseFrame();
                return Ok(Grab::Unchanged);
            }

            let copied = resource
                .ok_or_else(|| String::from("duplication produced an empty frame"))
                .and_then(|resource| {
                    resource
                        .cast::<ID3D11Texture2D>()
                        .map_err(|e| format!("frame was not a 2D texture: {e}"))
                })
                .and_then(|texture| self.read_back(&texture, x, y, width, height, out));

            // Released whichever way the read went — holding a frame
            // blocks every later acquire on this output, including ours.
            let _ = self.duplication.ReleaseFrame();
            copied.map(|()| Grab::Fresh)
        }
    }

    /// Copy the region out of `texture` via the staging surface.
    unsafe fn read_back(
        &self,
        texture: &ID3D11Texture2D,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        out: &mut Vec<u8>,
    ) -> Result<(), String> {
        unsafe {
            self.context.CopyResource(&self.staging, texture);

            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(|e| format!("could not map the frame for reading: {e}"))?;

            let result = copy_region(&mapped, x, y, width, height, out);
            self.context.Unmap(&self.staging, 0);
            result
        }
    }
}

/// Copy a BGRA region out of a mapped surface, unchanged.
///
/// The whole `unsafe` surface of the read-back is the one
/// `from_raw_parts` below: turning the mapped pointer into a slice of
/// the extent the region actually reaches. Everything past that — the
/// stride arithmetic that is the part historically got wrong — is
/// [`pack_rows`], which is safe, and therefore testable and measurable
/// without a GPU in the room.
unsafe fn copy_region(
    mapped: &D3D11_MAPPED_SUBRESOURCE,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    out: &mut Vec<u8>,
) -> Result<(), String> {
    if mapped.pData.is_null() {
        return Err("the mapped frame had no data".into());
    }
    let pitch = mapped.RowPitch as usize;
    let row_bytes = width as usize * 4;
    let x_bytes = x as usize * 4;
    if height == 0 || row_bytes == 0 {
        out.clear();
        return Ok(());
    }

    // The region's first row, and exactly what its last row reaches —
    // not the whole surface. A region that stops short of the bottom
    // must not describe bytes past it.
    let first = y as usize * pitch;
    let extent = (height as usize - 1) * pitch + x_bytes + row_bytes;

    // SAFETY: the surface is mapped for the duration of this call, and
    // the region was checked against the output's size by the caller —
    // so `extent` bytes from row `y` lie inside the mapped allocation.
    let surface =
        unsafe { std::slice::from_raw_parts((mapped.pData as *const u8).add(first), extent) };
    pack_rows(surface, pitch, x_bytes, row_bytes, height as usize, out)
        .then_some(())
        .ok_or_else(|| String::from("the mapped frame was smaller than the region"))
}

/// Copy `height` rows of `row_bytes`, `pitch` apart, into a packed
/// buffer.
///
/// This is the read-back's whole cost and the shape of it matters twice
/// over.
///
/// **Against `pitch`, never against `row_bytes`.** The driver pads rows
/// to its own alignment, and reading a padded surface as though it were
/// tightly packed shears the image progressively further right down the
/// frame — see the module note.
///
/// **One `copy_from_slice` per row.** That is a `memcpy`. The previous
/// shape appended four bytes at a time to a `Vec`, which re-proves the
/// length check and the possible reallocation on every pixel and so
/// never vectorises: at 5120x1440 that is 7.4 million bounded appends
/// against 1440 memcpys, for byte-for-byte the same result.
///
/// The destination is sized once and written through as a slice. It is
/// recycled across frames, so in the steady state the resize is a no-op
/// that leaves the capacity alone.
///
/// Returns `false` — writing nothing — when `src` is too small for the
/// geometry described, rather than reading past its end.
pub fn pack_rows(
    src: &[u8],
    pitch: usize,
    x_bytes: usize,
    row_bytes: usize,
    height: usize,
    out: &mut Vec<u8>,
) -> bool {
    if height == 0 || row_bytes == 0 {
        out.clear();
        return true;
    }
    let last = (height - 1) * pitch + x_bytes + row_bytes;
    if last > src.len() {
        return false;
    }

    out.clear();
    out.resize(row_bytes * height, 0);
    for (row, destination) in out.chunks_exact_mut(row_bytes).enumerate() {
        let start = row * pitch + x_bytes;
        destination.copy_from_slice(&src[start..start + row_bytes]);
    }
    true
}

/// The output driving a monitor, and what is needed to duplicate it.
struct FoundOutput {
    /// The adapter that owns the output. The device must be created on
    /// *this* one — duplication across adapters is not a thing, and on a
    /// laptop with switchable graphics the first adapter is routinely
    /// not the one driving the panel.
    adapter: IDXGIAdapter1,
    output: IDXGIOutput1,
    /// Top-left in virtual-desktop coordinates.
    origin: (i32, i32),
    width: u32,
    height: u32,
}

/// Find the adapter and output driving `hmonitor`, with its geometry.
unsafe fn find_output(hmonitor: HMONITOR) -> Result<FoundOutput, String> {
    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.map_err(|e| format!("no DXGI factory: {e}"))?;

    for adapter_index in 0.. {
        let adapter: IDXGIAdapter1 = match unsafe { factory.EnumAdapters1(adapter_index) } {
            Ok(a) => a,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(e) => return Err(format!("adapter enumeration failed: {e}")),
        };
        for output_index in 0.. {
            let output = match unsafe { adapter.EnumOutputs(output_index) } {
                Ok(o) => o,
                Err(_) => break,
            };
            let Ok(desc) = (unsafe { output.GetDesc() }) else {
                continue;
            };
            if desc.Monitor != hmonitor {
                continue;
            }
            let rect = desc.DesktopCoordinates;
            let (width, height) = (
                (rect.right - rect.left).max(0) as u32,
                (rect.bottom - rect.top).max(0) as u32,
            );
            if width == 0 || height == 0 {
                return Err("that output reports a zero-area desktop".into());
            }
            // Output1 is what carries `DuplicateOutput`.
            return output
                .cast::<IDXGIOutput1>()
                .map(|output| FoundOutput {
                    adapter,
                    output,
                    origin: (rect.left, rect.top),
                    width,
                    height,
                })
                .map_err(|e| format!("this driver has no output duplication: {e}"));
        }
    }
    Err("no DXGI output drives that monitor".into())
}

/// Create a D3D11 device on `adapter`.
unsafe fn create_device(
    adapter: &IDXGIAdapter1,
) -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    // `UNKNOWN` driver type is required — not preferred — when an
    // adapter is supplied.
    unsafe {
        D3D11CreateDevice(
            adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .map_err(|e| format!("no D3D11 device: {e}"))?;

    match (device, context) {
        (Some(d), Some(c)) => Ok((d, c)),
        _ => Err("D3D11 returned no device".into()),
    }
}

/// Allocate the CPU-readable surface frames are copied into.
unsafe fn create_staging(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<ID3D11Texture2D, String> {
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut staging: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }
        .map_err(|e| format!("no staging texture: {e}"))?;
    staging.ok_or_else(|| String::from("staging texture was not created"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "needs a desktop session that allows desktop duplication"]
    fn an_open_duplication_grabs_repeatedly_without_reopening() {
        use std::time::Instant;
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};

        let _guard = crate::windows::duplication_tests::one_at_a_time();
        crate::windows::duplication_tests::match_app_dpi_awareness();

        let hmon = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
        let mut duplicator = match MonitorDuplicator::open(hmon) {
            Ok(d) => d,
            Err(e) => {
                println!("duplication unavailable in this session: {e}");
                return;
            }
        };
        let (w, h) = duplicator.size();
        println!("output {w}x{h} at {:?}", duplicator.origin());

        let mut buffer = Vec::new();
        let mut fresh = 0;
        let mut unchanged = 0;
        let started = Instant::now();
        const RUNS: u32 = 30;
        for _ in 0..RUNS {
            match duplicator.grab_bgra(0, 0, w, h, &mut buffer) {
                Ok(Grab::Fresh) => fresh += 1,
                Ok(Grab::Unchanged) => unchanged += 1,
                Err(e) => {
                    println!("duplication ended: {e}");
                    return;
                }
            }
        }
        let each = started.elapsed() / RUNS;
        println!("{RUNS} grabs: {fresh} fresh, {unchanged} unchanged, {each:?} each");

        if fresh > 0 {
            assert_eq!(
                buffer.len(),
                w as usize * h as usize * 4,
                "a fresh grab must fill the whole region"
            );
            assert!(
                buffer.iter().any(|&b| b != 0),
                "every byte came back zero — a metadata-only frame was taken as a picture"
            );
            // Alpha is *not* asserted here any more: the read-back is a
            // straight copy of the surface, so whatever DWM left in that
            // byte comes through. Nothing downstream reads it — the NV12
            // converter discards it, and the one consumer that would
            // (GIF) forces it opaque when it materialises an RgbaImage.
        }
    }

    #[test]
    fn a_padded_surface_is_copied_row_by_row_rather_than_sheared() {
        // The trap from the module note, exercised without a GPU: a
        // driver's `RowPitch` is wider than `width * 4`, and a copy that
        // ignores it walks progressively further into each row's padding
        // — an image that leans further right the further down you look.
        let (width, height) = (3u32, 4u32);
        let row_bytes = width as usize * 4;
        let pitch = row_bytes + 16; // padding the copy must skip

        let mut surface = vec![0xCCu8; pitch * height as usize];
        for row in 0..height as usize {
            for px in 0..width as usize {
                let at = row * pitch + px * 4;
                // A recognisable BGRA value per pixel.
                surface[at] = row as u8;
                surface[at + 1] = px as u8;
                surface[at + 2] = 0x10;
                surface[at + 3] = 0xFF;
            }
        }

        let mapped = D3D11_MAPPED_SUBRESOURCE {
            pData: surface.as_mut_ptr() as *mut core::ffi::c_void,
            RowPitch: pitch as u32,
            DepthPitch: 0,
        };
        let mut out = Vec::new();
        // SAFETY: `surface` outlives the call and is at least
        // `pitch * height` bytes, which is what the geometry describes.
        unsafe { copy_region(&mapped, 0, 0, width, height, &mut out) }.expect("copy");

        assert_eq!(out.len(), row_bytes * height as usize);
        for row in 0..height as usize {
            for px in 0..width as usize {
                let at = row * row_bytes + px * 4;
                assert_eq!(
                    &out[at..at + 4],
                    &[row as u8, px as u8, 0x10, 0xFF],
                    "pixel ({px}, {row}) came from the wrong place"
                );
            }
        }
        assert!(
            !out.contains(&0xCC),
            "row padding leaked into the copied frame"
        );
    }

    #[test]
    fn an_offset_region_copies_from_the_right_corner() {
        // The other half of the same arithmetic: `x` is a byte offset
        // into each row and `y` skips whole rows.
        let (surface_w, surface_h) = (8usize, 6usize);
        let pitch = surface_w * 4;
        let mut surface = vec![0u8; pitch * surface_h];
        for row in 0..surface_h {
            for px in 0..surface_w {
                surface[row * pitch + px * 4] = (row * 16 + px) as u8;
            }
        }

        let mapped = D3D11_MAPPED_SUBRESOURCE {
            pData: surface.as_mut_ptr() as *mut core::ffi::c_void,
            RowPitch: pitch as u32,
            DepthPitch: 0,
        };
        let mut out = Vec::new();
        // SAFETY: the 2x2 region at (3, 2) lies inside the 8x6 surface.
        unsafe { copy_region(&mapped, 3, 2, 2, 2, &mut out) }.expect("copy");

        assert_eq!(out.len(), 2 * 2 * 4);
        assert_eq!(out[0], (2 * 16 + 3) as u8, "top-left of the region");
        assert_eq!(out[4], (2 * 16 + 4) as u8, "one pixel right");
        assert_eq!(out[8], (3 * 16 + 3) as u8, "one row down");
    }

    #[test]
    fn packing_refuses_a_source_too_small_for_its_geometry() {
        // The bound that keeps the `unsafe` above honest: if this read
        // past the end it would do so inside a mapped GPU surface, where
        // the symptom is a driver reset rather than a panic.
        let src = vec![0u8; 100];
        let mut out = vec![1u8; 8];
        assert!(!pack_rows(&src, 32, 0, 16, 8, &mut out));
        assert_eq!(out, vec![1u8; 8], "a refusal must write nothing");

        // The exact fit is allowed: three rows of 16 at pitch 32 reach
        // byte 2*32 + 16 = 80.
        let src = vec![0u8; 80];
        assert!(pack_rows(&src, 32, 0, 16, 3, &mut out));
        assert_eq!(out.len(), 48);
        // One byte short is not.
        let src = vec![0u8; 79];
        assert!(!pack_rows(&src, 32, 0, 16, 3, &mut out));
    }

    #[test]
    fn packing_zero_rows_empties_the_destination_rather_than_failing() {
        let mut out = vec![9u8; 64];
        assert!(pack_rows(&[], 0, 0, 16, 0, &mut out));
        assert!(out.is_empty());
    }

    #[test]
    fn a_recycled_buffer_is_resized_rather_than_appended_to() {
        // The recorder hands the same buffer back every frame. A copy
        // that appended would double its length each time.
        let mut surface = vec![7u8; 4 * 4 * 4];
        let mapped = D3D11_MAPPED_SUBRESOURCE {
            pData: surface.as_mut_ptr() as *mut core::ffi::c_void,
            RowPitch: 16,
            DepthPitch: 0,
        };
        let mut out = vec![0u8; 9_999];
        for _ in 0..3 {
            // SAFETY: a 4x4 region over a 4x4 surface.
            unsafe { copy_region(&mapped, 0, 0, 4, 4, &mut out) }.expect("copy");
            assert_eq!(out.len(), 4 * 4 * 4);
        }
    }

    #[test]
    #[ignore = "needs a desktop session that allows desktop duplication"]
    fn a_region_grab_costs_less_than_a_whole_output() {
        use std::time::Instant;

        let _guard = crate::windows::duplication_tests::one_at_a_time();
        crate::windows::duplication_tests::match_app_dpi_awareness();

        let Ok(mut duplicator) = MonitorDuplicator::open_at(0, 0) else {
            println!("duplication unavailable in this session");
            return;
        };
        let (w, h) = duplicator.size();
        let mut buffer = Vec::new();

        let time = |d: &mut MonitorDuplicator, rw: u32, rh: u32, buf: &mut Vec<u8>| {
            let started = Instant::now();
            for _ in 0..10 {
                let _ = d.grab_bgra(0, 0, rw, rh, buf);
            }
            started.elapsed() / 10
        };
        println!(
            "whole output {w}x{h}: {:?}",
            time(&mut duplicator, w, h, &mut buffer)
        );
        println!(
            "quarter region:      {:?}",
            time(&mut duplicator, w / 2, h / 2, &mut buffer)
        );
    }
}
