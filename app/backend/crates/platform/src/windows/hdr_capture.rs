//! Grab one monitor in scRGB half-float, for displays running in HDR.
//!
//! # Why not the ordinary path
//!
//! `xcap` — every other capture in the app — asks the compositor for an
//! 8-bit BGRA buffer. On an SDR display that is exactly right. On an HDR
//! display the desktop is composed in scRGB (linear, unbounded, `1.0` =
//! 80 nits), and the conversion down to 8 bits happens somewhere we
//! don't control, with no reference to what the display calls white.
//! The result is the washed-out screenshot every HDR user recognises.
//! This module takes the float frame instead and does the conversion
//! itself — see `domain::hdr` for that half.
//!
//! # Why Desktop Duplication rather than Windows.Graphics.Capture
//!
//! WGC is the newer API and the one `xcap` uses, but its frame pool is
//! built around a *stream* — a D3D device, a pooled surface set, an
//! event loop, and WinRT interop to turn an `HMONITOR` into a
//! `GraphicsCaptureItem`. Desktop Duplication takes a list of acceptable
//! formats directly (`DuplicateOutput1`), which is precisely the knob
//! this needs, and hands back one texture per call. For a still capture
//! that is the whole job, at a fraction of the surface area.
//!
//! It also inherits the property this app already depends on:
//! `WDA_EXCLUDEFROMCAPTURE` windows are absent from a duplicated frame,
//! so Clippity's own windows stay out of the shot exactly as they do
//! from the `xcap` path (see `capture_shield`).
//!
//! # This path requires a DPI-aware process
//!
//! `DuplicateOutput1` refuses with `DXGI_ERROR_UNSUPPORTED` when the
//! calling process is not DPI aware — undocumented, and independent of
//! the format list, the display's colour space and the adapter. The
//! shipped app is fine: tao calls `SetProcessDpiAwarenessContext` with
//! `PER_MONITOR_AWARE_V2` when it builds the event loop, long before
//! any capture runs.
//!
//! It is worth stating because of how the failure presents. The refusal
//! is indistinguishable from "this display is not in HDR mode", so a
//! host process that is not DPI aware does not get an error — it gets a
//! silent, permanent fallback to the 8-bit path. A bare `cargo test`
//! binary is exactly such a host, which is why the live tests here set
//! the awareness themselves rather than inheriting it.
//!
//! # Failure is always recoverable
//!
//! Every error here means "fall back to the ordinary 8-bit path", never
//! "the capture failed". Duplication can be refused for reasons that
//! have nothing to do with us — another process already holds the
//! output, a full-screen exclusive game owns the swap chain, the
//! session is remote — and a screenshot the user asked for must not be
//! lost to any of them.

use std::sync::atomic::{AtomicBool, Ordering};

use windows::core::Interface;
use windows::Win32::Foundation::{E_FAIL, HMODULE};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_R16G16B16A16_FLOAT;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput5, IDXGIOutputDuplication,
    IDXGIResource, DXGI_ERROR_NOT_FOUND, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::Graphics::Gdi::HMONITOR;

use clippity_domain::hdr;

use super::hdr_display;

/// How long one `AcquireNextFrame` waits, in milliseconds.
const ACQUIRE_TIMEOUT_MS: u32 = 250;

/// How many times to ask for a frame before giving up.
///
/// Two different non-answers are being retried past, and a frame has to
/// get past both. Desktop Duplication delivers on *change*, so on a
/// still desktop a call can time out with nothing having gone wrong;
/// and it answers immediately with a metadata-only frame whenever
/// nothing has been presented yet, which carries no desktop image at
/// all (see [`acquire_frame`]). Neither consumes the budget the way a
/// real failure would — the metadata-only case returns instantly — so a
/// handful of attempts covers the gap between "nothing is moving" and
/// "this output is genuinely not going to produce anything".
const ACQUIRE_ATTEMPTS: usize = 6;

/// One monitor's pixels, still in scRGB.
pub struct HdrGrab {
    /// Tightly packed RGBA, four `f32` per pixel, linear scRGB.
    pub pixels: Vec<f32>,
    pub width: u32,
    pub height: u32,
    /// What the display calls SDR white. Carried alongside the pixels
    /// because the two are only meaningful together — the same buffer
    /// tone-maps to a different image at a different white level.
    pub sdr_white_nits: f32,
}

impl HdrGrab {
    /// Tone-map to RGBA8, ready for the ordinary encode path.
    pub fn to_rgba8(&self) -> Vec<u8> {
        hdr::tone_map_frame(&self.pixels, self.width, self.height, self.sdr_white_nits)
    }
}

/// Whether the HDR capture path may be used at all.
///
/// Backs the `capture.hdr` developer feature flag. Turning it off makes
/// [`rgba_monitor_at`] report "not applicable", which routes every
/// capture down the ordinary 8-bit grab — the exact comparison a user
/// needs when a shot off an HDR display looks wrong and the question is
/// whether the tone map is why.
///
/// A process global rather than a parameter because the two callers are
/// three-line `cfg` shims in different services, and threading a
/// preference through both would put a settings dependency in the
/// capture path for a switch that is off in every ordinary session.
static ENABLED: AtomicBool = AtomicBool::new(true);

/// Arm or disarm the HDR capture path.
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// Whether the HDR capture path is armed.
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Capture `hmonitor` in scRGB, or explain why not.
///
/// Returns `Ok(None)` — not an error — when the monitor simply is not
/// in HDR mode. That is the overwhelmingly common case and the caller's
/// correct response is to use the ordinary path, which this states
/// rather than dressing up as a failure.
pub fn capture_if_hdr(hmonitor: HMONITOR) -> Result<Option<HdrGrab>, String> {
    let info = hdr_display::describe(hmonitor);
    if !info.hdr_active {
        return Ok(None);
    }
    capture_scrgb(hmonitor, info.sdr_white_nits).map(Some)
}

/// Tone-mapped RGBA for the monitor containing the screen point
/// `(x, y)`, or `None` when the ordinary capture path should be used.
///
/// **The entry point the capture services call**, and deliberately the
/// only one: it takes a screen coordinate rather than an `HMONITOR` so
/// the services crate never has to name a Win32 type, and it returns
/// `None` for every "not applicable" and every failure alike. Callers
/// have exactly one branch to write — `None` means "grab it the way you
/// always did" — which is what keeps the HDR path from becoming a
/// second capture pipeline that can fail on its own.
///
/// Failures are logged here rather than returned, because no caller can
/// act on them differently.
pub fn rgba_monitor_at(x: i32, y: i32) -> Option<image::RgbaImage> {
    if !enabled() {
        return None;
    }
    let hmonitor = monitor_at(x, y)?;
    let grab = match capture_if_hdr(hmonitor) {
        Ok(Some(grab)) => grab,
        // Not an HDR display: overwhelmingly the common case, and not
        // worth a log line on every capture.
        Ok(None) => return None,
        Err(e) => {
            tracing::debug!("HDR capture unavailable, using the ordinary path: {e}");
            return None;
        }
    };
    let (w, h) = (grab.width, grab.height);
    image::RgbaImage::from_raw(w, h, grab.to_rgba8())
}

/// Resolve the monitor under a screen point.
fn monitor_at(x: i32, y: i32) -> Option<HMONITOR> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONULL};

    // SAFETY: a by-value POINT and a documented flag. `DEFAULTTONULL`
    // rather than `DEFAULTTONEAREST` on purpose — a point that is on no
    // monitor means the caller's geometry is stale, and capturing the
    // *nearest* display would silently produce the wrong screen.
    let hmon = unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONULL) };
    (!hmon.is_invalid()).then_some(hmon)
}

/// Capture `hmonitor` in scRGB regardless of its reported mode.
///
/// Split from [`capture_if_hdr`] so the live test can exercise the
/// duplication path on an SDR display, where the frame comes back with
/// everything sitting at or below `1.0` — still a valid scRGB buffer,
/// just an uninteresting one.
pub fn capture_scrgb(hmonitor: HMONITOR, sdr_white_nits: f32) -> Result<HdrGrab, String> {
    // SAFETY: a linear D3D11 + DXGI sequence. Every interface is
    // reference-counted by `windows` and released on drop; the one
    // manual lifetime is the acquired frame, released before the
    // duplication goes out of scope.
    unsafe {
        let (adapter, output) = find_output(hmonitor)?;
        let (device, context) = create_device(&adapter)?;

        // The format list is the entire reason this module exists: it
        // asks the compositor for the desktop *before* it is squeezed
        // into 8 bits.
        let duplication: IDXGIOutputDuplication = output
            .DuplicateOutput1(&device, 0, &[DXGI_FORMAT_R16G16B16A16_FLOAT])
            .map_err(|e| format!("float desktop duplication refused: {e}"))?;

        let texture = acquire_frame(&duplication)?;
        let result = read_back(&device, &context, &texture, sdr_white_nits);
        // Released whichever way the read went — holding a frame blocks
        // every later duplication on this output, including ours.
        let _ = duplication.ReleaseFrame();
        result
    }
}

/// Find the adapter + output pair driving `hmonitor`.
///
/// The device has to be created on the adapter that owns the output;
/// duplication across adapters is not a thing, and on a laptop with
/// switchable graphics the first adapter is frequently the wrong one.
unsafe fn find_output(hmonitor: HMONITOR) -> Result<(IDXGIAdapter1, IDXGIOutput5), String> {
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
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(_) => break,
            };
            let Ok(desc) = (unsafe { output.GetDesc() }) else {
                continue;
            };
            if desc.Monitor != hmonitor {
                continue;
            }
            // Output5 is what carries `DuplicateOutput1`, and with it
            // the ability to ask for a format at all.
            return output
                .cast::<IDXGIOutput5>()
                .map(|o5| (adapter, o5))
                .map_err(|e| format!("this driver has no float-capable duplication: {e}"));
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
    // `UNKNOWN` driver type is required — and not optional — when an
    // adapter is supplied: passing HARDWARE with an explicit adapter is
    // an invalid-argument error rather than a preference.
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

/// Pull one frame that actually carries a desktop image.
///
/// # Why `LastPresentTime` is checked rather than trusted
///
/// A brand-new duplication answers its first `AcquireNextFrame`
/// immediately and successfully, with `AccumulatedFrames` and
/// `LastPresentTime` both zero. That frame is *metadata only* — pointer
/// position and shape — laid over a desktop surface nothing has been
/// composed into yet, which on a fresh allocation is zero-filled. Taking
/// it produces a completely black capture, and one that fails silently:
/// the format is right, the dimensions are right, every error path stays
/// quiet, and the file is simply black.
///
/// `LastPresentTime` is the field that separates the two. Non-zero means
/// a present has been composed into the surface, so the pixels are real.
unsafe fn acquire_frame(duplication: &IDXGIOutputDuplication) -> Result<ID3D11Texture2D, String> {
    let mut last_err = String::from("no frame arrived");
    for _ in 0..ACQUIRE_ATTEMPTS {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        match unsafe { duplication.AcquireNextFrame(ACQUIRE_TIMEOUT_MS, &mut info, &mut resource) }
        {
            Ok(()) => {
                let Some(resource) = resource else {
                    last_err = "duplication produced an empty frame".into();
                    // Nothing to release when nothing arrived.
                    continue;
                };
                if info.LastPresentTime == 0 {
                    // Metadata-only: the surface behind it holds no
                    // desktop image. Hand it back and wait for a real
                    // present rather than capturing black.
                    last_err = "duplication produced no desktop image".into();
                    drop(resource);
                    let _ = unsafe { duplication.ReleaseFrame() };
                    continue;
                }
                return resource
                    .cast::<ID3D11Texture2D>()
                    .map_err(|e| format!("frame was not a 2D texture: {e}"));
            }
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                // A static desktop, not a fault. Ask again — and do not
                // release, because a timeout means nothing was acquired.
                last_err = "the desktop produced no new frame".into();
            }
            Err(e) => return Err(format!("frame acquisition failed: {e}")),
        }
    }
    Err(last_err)
}

/// Copy the GPU texture into system memory and widen it to `f32`.
unsafe fn read_back(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    texture: &ID3D11Texture2D,
    sdr_white_nits: f32,
) -> Result<HdrGrab, String> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };

    if desc.Format != DXGI_FORMAT_R16G16B16A16_FLOAT {
        // The duplication accepted the format request but delivered
        // something else. Bailing keeps the misread out of the file:
        // reading BGRA8 as half-float produces colourful noise, which
        // is far worse than falling back.
        return Err(format!(
            "expected a half-float frame, got DXGI format {}",
            desc.Format.0
        ));
    }
    let (width, height) = (desc.Width, desc.Height);
    if width == 0 || height == 0 {
        return Err("duplicated frame has zero area".into());
    }

    // A staging copy is the only way the CPU may read a duplicated
    // frame — the source texture lives in GPU memory with no CPU access.
    let staging_desc = D3D11_TEXTURE2D_DESC {
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
        ..desc
    };
    let mut staging: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&staging_desc, None, Some(&mut staging)) }
        .map_err(|e| format!("no staging texture: {e}"))?;
    let staging = staging.ok_or_else(|| String::from("staging texture was not created"))?;

    unsafe { context.CopyResource(&staging, texture) };

    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
        .map_err(|e| format!("could not map the frame for reading: {e}"))?;

    let pixels = unsafe { widen(&mapped, width, height) };
    unsafe { context.Unmap(&staging, 0) };

    let pixels = pixels.ok_or_else(|| windows::core::Error::from(E_FAIL).to_string())?;
    Ok(HdrGrab {
        pixels,
        width,
        height,
        sdr_white_nits,
    })
}

/// Widen a mapped `R16G16B16A16_FLOAT` surface to `f32` RGBA.
///
/// Reads row by row against `RowPitch` rather than assuming the rows are
/// contiguous. They usually are not: the driver pads each row to its own
/// alignment, and treating a padded surface as tightly packed produces
/// an image that shears progressively further right down the frame.
unsafe fn widen(mapped: &D3D11_MAPPED_SUBRESOURCE, width: u32, height: u32) -> Option<Vec<f32>> {
    if mapped.pData.is_null() {
        return None;
    }
    let row_bytes = (width as usize) * 4 * 2;
    if (mapped.RowPitch as usize) < row_bytes {
        return None;
    }
    let mut out = Vec::with_capacity((width as usize) * (height as usize) * 4);
    for row in 0..height as usize {
        // SAFETY: the surface is mapped, and the offset stays inside it
        // — `RowPitch` is the driver's own stride and the loop stops at
        // the declared height.
        let start = unsafe { (mapped.pData as *const u8).add(row * mapped.RowPitch as usize) };
        let row_slice = unsafe { std::slice::from_raw_parts(start, row_bytes) };
        for half in row_slice.chunks_exact(2) {
            out.push(f16_to_f32(u16::from_le_bytes([half[0], half[1]])));
        }
    }
    Some(out)
}

/// IEEE 754 binary16 → binary32.
///
/// Written out rather than pulled from a crate: it is a dozen lines, it
/// is the only thing this app needs from any half-float library, and
/// having it here means the subnormal and infinity cases are covered by
/// tests in the same file as the code that depends on them. Subnormals
/// matter — near-black HDR pixels land there, and flushing them to zero
/// crushes shadow detail into a flat black.
pub fn f16_to_f32(bits: u16) -> f32 {
    let sign = (bits & 0x8000) as u32;
    let exponent = ((bits >> 10) & 0x1F) as u32;
    let mantissa = (bits & 0x03FF) as u32;

    let out = match exponent {
        // Zero or subnormal: no implicit leading 1, so the value is
        // reconstructed by scaling rather than by re-biasing.
        0 => {
            if mantissa == 0 {
                sign << 16
            } else {
                // Normalise: shift the mantissa up until its top bit
                // carries out, tracking the exponent as we go.
                let mut e = -1i32;
                let mut m = mantissa;
                loop {
                    e += 1;
                    m <<= 1;
                    if m & 0x0400 != 0 {
                        break;
                    }
                }
                let exp32 = (127 - 15 - e) as u32;
                (sign << 16) | (exp32 << 23) | ((m & 0x03FF) << 13)
            }
        }
        // Infinity or NaN: the exponent saturates in both formats.
        0x1F => (sign << 16) | 0x7F80_0000 | (mantissa << 13),
        // Normal: re-bias the exponent (15 → 127) and pad the mantissa.
        _ => (sign << 16) | ((exponent + 112) << 23) | (mantissa << 13),
    };
    f32::from_bits(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialises the live tests that duplicate an output.
    ///
    /// Desktop Duplication permits one duplication per output per
    /// process, so two of these running concurrently — which is the
    /// default, `cargo test` being threaded — make each other fail with
    /// `E_INVALIDARG`. That matters more than an ordinary flake: these
    /// tests treat a refusal as "not this code's fault" and return
    /// early, so the collision does not show up as a failure. It shows
    /// up as a test that passes without asserting anything.
    static DUPLICATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Take the duplication lock, ignoring poisoning — a panic in
    /// another live test says nothing about whether this one can run.
    fn one_duplication_at_a_time() -> std::sync::MutexGuard<'static, ()> {
        DUPLICATION.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Give this process the DPI awareness the shipped app runs with.
    ///
    /// Not a convenience: `DuplicateOutput1` refuses with
    /// `DXGI_ERROR_UNSUPPORTED` in a DPI-unaware process, and a bare
    /// `cargo test` binary is DPI-unaware. tao makes the real app
    /// per-monitor-v2 aware before any capture runs (see the module
    /// docs), so a live test that skips this is exercising a
    /// configuration the app is never in — every float grab refuses,
    /// the refusal looks exactly like "this display is not HDR", and
    /// the whole path silently reports itself as covered.
    fn match_app_dpi_awareness() {
        #[link(name = "user32")]
        extern "system" {
            fn SetProcessDpiAwarenessContext(value: isize) -> i32;
        }
        /// `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`, which is what
        /// tao sets. Idempotent, and failing is harmless — a later
        /// call in the same process just returns false.
        const PER_MONITOR_AWARE_V2: isize = -4;
        // SAFETY: a documented user32 call taking a constant.
        unsafe { SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) };
    }

    /// Encode an `f32` as binary16, for round-trip tests. Test-only —
    /// the capture path only ever decodes.
    fn f32_to_f16(value: f32) -> u16 {
        let bits = value.to_bits();
        let sign = ((bits >> 16) & 0x8000) as u16;
        let exp = ((bits >> 23) & 0xFF) as i32 - 127 + 15;
        let mantissa = (bits & 0x007F_FFFF) >> 13;
        if exp <= 0 {
            return sign;
        }
        if exp >= 0x1F {
            return sign | 0x7C00;
        }
        sign | ((exp as u16) << 10) | mantissa as u16
    }

    #[test]
    fn decodes_the_anchor_values() {
        assert_eq!(f16_to_f32(0x0000), 0.0);
        assert_eq!(f16_to_f32(0x3C00), 1.0);
        assert_eq!(f16_to_f32(0x4000), 2.0);
        assert_eq!(f16_to_f32(0xBC00), -1.0);
        assert_eq!(f16_to_f32(0x3800), 0.5);
    }

    #[test]
    fn decodes_negative_zero_as_zero() {
        let v = f16_to_f32(0x8000);
        assert_eq!(v, 0.0);
        assert!(v.is_sign_negative(), "sign should survive the widen");
    }

    #[test]
    fn round_trips_values_a_desktop_actually_contains() {
        // scRGB desktop content: SDR range, plus the HDR overrange a
        // highlight sits in.
        for v in [0.0f32, 0.25, 0.5, 1.0, 2.0, 2.5, 6.0, 12.5, 100.0] {
            let back = f16_to_f32(f32_to_f16(v));
            assert!(
                (back - v).abs() < v.abs() * 1e-3 + 1e-6,
                "{v} round-tripped to {back}"
            );
        }
    }

    #[test]
    fn handles_subnormals_instead_of_flushing_them_to_zero() {
        // Near-black HDR pixels land here. Flushing them crushes
        // shadow detail into a flat black.
        let smallest_subnormal = f16_to_f32(0x0001);
        assert!(smallest_subnormal > 0.0);
        assert!(smallest_subnormal < 1e-6);

        let largest_subnormal = f16_to_f32(0x03FF);
        assert!(largest_subnormal > smallest_subnormal);
        // The next value up is the smallest *normal*, and the sequence
        // must be continuous across the boundary.
        assert!(f16_to_f32(0x0400) > largest_subnormal);
    }

    #[test]
    fn subnormals_are_evenly_spaced() {
        // The tell-tale of a correct normalisation loop: the gap
        // between consecutive subnormals is constant.
        let step = f16_to_f32(0x0002) - f16_to_f32(0x0001);
        for bits in 1u16..0x03FF {
            let gap = f16_to_f32(bits + 1) - f16_to_f32(bits);
            assert!(
                (gap - step).abs() < step * 1e-3,
                "gap at {bits:#06x} was {gap}, expected {step}"
            );
        }
    }

    #[test]
    fn carries_infinity_and_nan_through() {
        assert!(f16_to_f32(0x7C00).is_infinite());
        assert!(f16_to_f32(0x7C00).is_sign_positive());
        assert!(f16_to_f32(0xFC00).is_infinite());
        assert!(f16_to_f32(0xFC00).is_sign_negative());
        assert!(f16_to_f32(0x7E00).is_nan());
    }

    #[test]
    fn decoding_is_monotonic_across_the_positive_range() {
        // A wrong exponent bias shows up as a discontinuity long before
        // it shows up as a wrong colour.
        let mut prev = f16_to_f32(0);
        for bits in 1u16..0x7C00 {
            let v = f16_to_f32(bits);
            assert!(v >= prev, "decode dipped at {bits:#06x}: {prev} -> {v}");
            prev = v;
        }
    }

    /// The contract every caller depends on: on a display that is not
    /// in HDR mode, the entry point declines and the ordinary capture
    /// path runs untouched.
    ///
    /// This is the regression that would matter most — quietly routing
    /// every SDR screenshot through a second pipeline — and it is worth
    /// asserting against real hardware rather than reasoning about.
    /// Skips itself with a note if the machine *is* in HDR mode, where
    /// the opposite answer is the correct one.
    #[test]
    #[ignore = "needs a desktop session with a monitor attached"]
    fn an_sdr_display_declines_and_leaves_the_ordinary_path_alone() {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};

        // SAFETY: DEFAULTTOPRIMARY always resolves to a monitor.
        let hmon = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
        if hdr_display::describe(hmon).hdr_active {
            println!("primary display is in HDR mode — nothing to assert here");
            return;
        }
        assert!(
            rgba_monitor_at(1, 1).is_none(),
            "an SDR display must fall through to the ordinary capture path"
        );
    }

    /// Live check of everything *before* the format negotiation.
    ///
    /// Separate from the grab test below because it can pass on an SDR
    /// machine, where `DuplicateOutput1` legitimately refuses a
    /// float-only format list — which would otherwise leave the whole
    /// discovery path untested on any developer machine that isn't in
    /// HDR mode. What it covers is the "wrong adapter" family of bugs:
    /// on a laptop with switchable graphics the first adapter is
    /// routinely not the one driving the panel, and creating the device
    /// on it fails in ways that look like a format problem.
    #[test]
    #[ignore = "needs a desktop session with a monitor attached"]
    fn finds_the_adapter_that_actually_drives_the_display() {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};

        // SAFETY: DEFAULTTOPRIMARY always resolves to a monitor.
        let hmon = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };

        // SAFETY: both are ordinary DXGI/D3D11 calls; the interfaces
        // they return are released on drop.
        let (adapter, _output) =
            unsafe { find_output(hmon) }.expect("an output drives the primary");
        let (device, _context) =
            unsafe { create_device(&adapter) }.expect("a D3D11 device on that adapter");

        // A staging texture is the other half of the read-back path and
        // is format-independent, so it can be proven here too.
        let desc = D3D11_TEXTURE2D_DESC {
            Width: 16,
            Height: 16,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R16G16B16A16_FLOAT,
            SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging: Option<ID3D11Texture2D> = None;
        // SAFETY: a fully-populated descriptor with no initial data.
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }
            .expect("a half-float staging texture");
        assert!(
            staging.is_some(),
            "the read-back path cannot allocate its staging surface"
        );
    }

    /// A grabbed frame must contain the desktop, not a blank surface.
    ///
    /// The regression this pins shipped: a new duplication answers its
    /// first `AcquireNextFrame` immediately and successfully with
    /// `LastPresentTime == 0`, over a surface nothing has been composed
    /// into. Taking that frame yields a fully black capture through a
    /// path where every error check passes — right format, right
    /// dimensions, no error returned — so nothing but the pixels can
    /// catch it. Those metadata-only frames keep arriving throughout
    /// the stream, so this is not a first-capture-only problem.
    ///
    /// Asserts "not uniformly black" rather than any particular
    /// content, since what is on the desktop is not this test's to
    /// know. A genuinely black desktop would false-pass, which is
    /// preferable to a test that needs a fixture on screen.
    #[test]
    #[ignore = "needs a desktop session that allows desktop duplication"]
    fn a_grabbed_frame_carries_desktop_pixels_rather_than_a_blank_surface() {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};

        let _guard = one_duplication_at_a_time();
        match_app_dpi_awareness();
        // SAFETY: DEFAULTTOPRIMARY always resolves to a monitor.
        let hmon = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
        let info = hdr_display::describe(hmon);

        let grab = match capture_scrgb(hmon, info.sdr_white_nits) {
            Ok(grab) => grab,
            Err(e) => {
                // Refusable for reasons that are not this code's fault
                // — see the module docs.
                println!("duplication unavailable in this session: {e}");
                return;
            }
        };
        let peak = grab.pixels.iter().cloned().fold(0.0f32, f32::max);
        println!(
            "grabbed {}x{} at {} nits, peak scRGB {peak:.3}",
            grab.width, grab.height, info.sdr_white_nits
        );
        assert!(
            peak > 0.0,
            "every pixel came back zero — the grab took a metadata-only \
             frame instead of waiting for one carrying a desktop image"
        );
    }

    /// Live check against this machine's primary display.
    ///
    /// `#[ignore]`d: needs a desktop session, and Desktop Duplication is
    /// legitimately refusable (another capture tool holding the output,
    /// a full-screen exclusive game, a remote session). It asserts the
    /// frame's *shape* rather than its contents — what it is really
    /// proving is that the format request was honoured, which is the
    /// part that silently degrades.
    #[test]
    #[ignore = "needs a desktop session that allows desktop duplication"]
    fn grabs_a_real_float_frame_from_the_primary_display() {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};

        let _guard = one_duplication_at_a_time();
        match_app_dpi_awareness();
        // SAFETY: DEFAULTTOPRIMARY always resolves to a monitor.
        let hmon = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
        let info = hdr_display::describe(hmon);
        println!("primary display: {info:?}");

        match capture_scrgb(hmon, info.sdr_white_nits) {
            Ok(grab) => {
                assert!(grab.width > 0 && grab.height > 0);
                assert_eq!(
                    grab.pixels.len(),
                    grab.width as usize * grab.height as usize * 4,
                    "pixel buffer does not match the frame it claims"
                );
                assert!(
                    grab.pixels.iter().all(|v| v.is_finite()),
                    "a non-finite component means the widen is misreading the surface"
                );
                let rgba = grab.to_rgba8();
                assert_eq!(rgba.len(), grab.width as usize * grab.height as usize * 4);
                let peak = grab.pixels.iter().cloned().fold(0.0f32, f32::max);
                println!(
                    "grabbed {}x{}, peak scRGB {peak:.3}, hdr_active={}",
                    grab.width, grab.height, info.hdr_active
                );
            }
            Err(e) => {
                // Not a failure of this code — see the module docs on
                // why duplication is refusable.
                println!("duplication unavailable in this session: {e}");
            }
        }
    }
}
