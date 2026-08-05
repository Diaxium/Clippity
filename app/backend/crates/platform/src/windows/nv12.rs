//! BGRA → NV12 colour conversion for the H.264 encoder.
//!
//! **Why convert ourselves instead of handing Media Foundation RGB32.**
//! The sink writer will happily take `MFVideoFormat_RGB32` input and
//! insert the Color Converter DSP, but that path carries two problems
//! this one doesn't:
//!
//! 1. *Orientation is ambiguous.* MF inherits the GDI convention where
//!    an uncompressed RGB surface is bottom-up unless the stride says
//!    otherwise, so a top-down capture buffer produces a vertically
//!    mirrored recording unless `MF_MT_DEFAULT_STRIDE` is negative and
//!    the source pointer is aimed at the last row. It is a silent
//!    failure — the file is valid, just upside down. NV12 has no such
//!    convention: it is always top-down.
//! 2. *It is untestable here.* The DSP only runs inside a live MF
//!    pipeline. A pure conversion is a function over bytes, so the
//!    pixel path — the part most likely to be subtly wrong — gets unit
//!    tests instead of a manual "watch the recording back" check.
//!
//! The conversion is BT.709 limited range, which is what an HD H.264
//! decoder assumes when the stream carries no colour metadata. Getting
//! this wrong doesn't break playback; it washes out or crushes the
//! contrast, which on a *screen* recording (hard edges, saturated UI
//! chrome, text) is far more visible than it is on camera footage.

/// Fixed-point BT.709 limited-range coefficients, scaled by 256.
///
/// Integer rather than float because this runs per-pixel on every frame
/// of every recording: at 1080p30 that's 62 M pixels/second, where the
/// float round-trip is measurable and the precision buys nothing (the
/// output is 8-bit).
const Y_R: i32 = 47;
const Y_G: i32 = 157;
const Y_B: i32 = 16;
const U_R: i32 = -26;
const U_G: i32 = -87;
const U_B: i32 = 112;
const V_R: i32 = 112;
const V_G: i32 = -102;
const V_B: i32 = -10;

/// Studio-swing offsets. Luma rides 16..=235, chroma 16..=240 — the
/// "limited range" the coefficients above are scaled for.
const Y_OFFSET: i32 = 16;
const C_OFFSET: i32 = 128;
const Y_MIN: i32 = 16;
const Y_MAX: i32 = 235;
const C_MIN: i32 = 16;
const C_MAX: i32 = 240;

/// Size in bytes of an NV12 buffer for `width × height`.
///
/// NV12 is a full-resolution 8-bit luma plane followed by a
/// half-resolution interleaved chroma plane — 12 bits per pixel, hence
/// the 3/2. Both dimensions must be even (the caller guarantees this
/// via `domain::recorder::even_dimensions`), so the division is exact.
pub fn nv12_len(width: u32, height: u32) -> usize {
    (width as usize * height as usize * 3) / 2
}

/// Byte order of the source frame's colour channels.
///
/// Both orders reach this module: a decoded clip is RGBA, while every
/// raw Win32 surface (GDI DIBs, the recorder's Desktop Duplication
/// read-back) is BGRA. Passing the wrong one doesn't fail — it swaps red
/// and blue in the recording, which is why the caller states it
/// explicitly rather than this module assuming.
///
/// Re-exported from the domain, where it moved once the sinks began
/// carrying it: absorbing the swap here — the two indices below are read
/// per pixel either way — is what lets a BGRA capture reach the encoder
/// without a normalising pass over the whole frame first.
pub use clippity_domain::pixels::PixelOrder;

/// Convert a top-down frame into NV12, writing into `dst`.
///
/// `src` is `width × height` pixels in `order`; the alpha byte is
/// discarded, since video has no alpha channel. `dst` must be exactly
/// [`nv12_len`] bytes.
///
/// Chroma is averaged over each 2×2 luma block rather than point-sampled
/// from one corner. Point sampling is cheaper and is what a naive
/// converter does, but on screen content it visibly fringes every
/// single-pixel-wide coloured line — which is most of a UI.
///
/// Returns `false` (writing nothing) when the buffers don't match the
/// declared geometry, so a mis-sized frame can't read out of bounds.
pub fn to_nv12(src: &[u8], dst: &mut [u8], width: u32, height: u32, order: PixelOrder) -> bool {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || w % 2 != 0 || h % 2 != 0 {
        return false;
    }
    if src.len() < w * h * 4 || dst.len() < nv12_len(width, height) {
        return false;
    }

    let (ri, bi) = order.red_blue();
    let (luma, chroma) = dst.split_at_mut(w * h);

    // Bytes per row-pair in each buffer. A row-pair is the unit of work
    // because it is the smallest span that produces a whole row of
    // chroma: two luma rows and one chroma row come out of it together.
    let src_pair = w * 4 * 2;
    let luma_pair = w * 2;
    let chroma_pair = w;
    let pairs = h / 2;

    // Split across cores by row-pair band.
    //
    // This is the frame's dominant cost at any size that matters: a
    // 5120x1440 frame is 7.4 million pixels, and doing them one after
    // another took 200 ms — six frame budgets, on its own, before the
    // encoder has seen anything. The work is embarrassingly parallel
    // (no pixel depends on another) and the bands are disjoint slices,
    // so this needs no synchronisation: the pool's `run` borrows the
    // buffers and does not return until every band is finished.
    //
    // A *pool* rather than `std::thread::scope`, which is what this used
    // to be: scope creates and joins its threads per call, so at 60 fps
    // it spent a frame budget's worth of every second in the kernel
    // making threads it had just destroyed. See `parallel`.
    let pool = crate::parallel::BandPool::shared();
    let threads = pool.parallelism().min(pairs.max(1));

    let band = pairs.div_ceil(threads.max(1));
    let mut src_rest = &src[..pairs * src_pair];
    let mut luma_rest = &mut luma[..pairs * luma_pair];
    let mut chroma_rest = &mut chroma[..pairs * chroma_pair];

    let mut jobs: Vec<Box<dyn FnOnce() + Send>> = Vec::with_capacity(threads);
    while !src_rest.is_empty() {
        let take = band.min(src_rest.len() / src_pair);
        let (src_band, s) = src_rest.split_at(take * src_pair);
        let (luma_band, l) = luma_rest.split_at_mut(take * luma_pair);
        let (chroma_band, c) = chroma_rest.split_at_mut(take * chroma_pair);
        src_rest = s;
        luma_rest = l;
        chroma_rest = c;
        jobs.push(Box::new(move || {
            convert_band(src_band, luma_band, chroma_band, w, ri, bi)
        }));
    }
    pool.run(jobs);

    true
}

/// Convert a contiguous run of row-pairs.
///
/// **One pass over the source, not two.** The previous shape walked
/// every pixel for luma and then walked them all again for chroma,
/// which reads a 28 MiB frame twice and evicts the start of it before
/// the second pass arrives. Doing both from the same four loaded pixels
/// halves the memory traffic, and memory traffic is what this is made
/// of.
fn convert_band(src: &[u8], luma: &mut [u8], chroma: &mut [u8], w: usize, ri: usize, bi: usize) {
    for ((src_pair, luma_pair), chroma_row) in src
        .chunks_exact(w * 4 * 2)
        .zip(luma.chunks_exact_mut(w * 2))
        .zip(chroma.chunks_exact_mut(w))
    {
        let (top, bottom) = src_pair.split_at(w * 4);
        let (luma_top, luma_bottom) = luma_pair.split_at_mut(w);

        // Four pixels, four luma samples and one chroma sample, from a
        // single load of each. Iterating in 2x2 blocks over slices lets
        // the bounds checks fall out — the compiler can see every span
        // is exactly two pixels wide.
        for ((((top_px, bottom_px), luma_top_px), luma_bottom_px), chroma_px) in top
            .chunks_exact(8)
            .zip(bottom.chunks_exact(8))
            .zip(luma_top.chunks_exact_mut(2))
            .zip(luma_bottom.chunks_exact_mut(2))
            .zip(chroma_row.chunks_exact_mut(2))
        {
            let (mut sr, mut sg, mut sb) = (0i32, 0i32, 0i32);
            for (i, px) in [&top_px[..4], &top_px[4..], &bottom_px[..4], &bottom_px[4..]]
                .into_iter()
                .enumerate()
            {
                let r = px[ri] as i32;
                let g = px[1] as i32;
                let b = px[bi] as i32;
                sr += r;
                sg += g;
                sb += b;
                let y = clamp_y((Y_R * r + Y_G * g + Y_B * b + 128) >> 8);
                match i {
                    0 => luma_top_px[0] = y,
                    1 => luma_top_px[1] = y,
                    2 => luma_bottom_px[0] = y,
                    _ => luma_bottom_px[1] = y,
                }
            }

            // Average the block, keeping the /4 inside the fixed-point
            // maths so the rounding happens once.
            let (r, g, b) = (sr / 4, sg / 4, sb / 4);
            // NV12 interleaves U before V within the chroma plane.
            chroma_px[0] = clamp_c(((U_R * r + U_G * g + U_B * b + 128) >> 8) + C_OFFSET);
            chroma_px[1] = clamp_c(((V_R * r + V_G * g + V_B * b + 128) >> 8) + C_OFFSET);
        }
    }
}

fn clamp_y(value: i32) -> u8 {
    (value + Y_OFFSET).clamp(Y_MIN, Y_MAX) as u8
}

fn clamp_c(value: i32) -> u8 {
    value.clamp(C_MIN, C_MAX) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a solid-colour BGRA frame.
    fn solid(width: u32, height: u32, r: u8, g: u8, b: u8) -> Vec<u8> {
        let mut buf = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..width * height {
            buf.extend_from_slice(&[b, g, r, 255]);
        }
        buf
    }

    fn convert(width: u32, height: u32, src: &[u8]) -> Vec<u8> {
        let mut dst = vec![0u8; nv12_len(width, height)];
        assert!(to_nv12(src, &mut dst, width, height, PixelOrder::Bgra));
        dst
    }

    #[test]
    fn nv12_is_twelve_bits_per_pixel() {
        assert_eq!(nv12_len(1920, 1080), 1920 * 1080 * 3 / 2);
        assert_eq!(nv12_len(2, 2), 6);
    }

    #[test]
    fn black_and_white_land_on_the_studio_swing_endpoints() {
        // Limited range: black is 16, not 0; white is 235, not 255.
        // Getting this backwards is the classic "washed out / crushed
        // blacks" recording bug.
        let black = convert(2, 2, &solid(2, 2, 0, 0, 0));
        assert_eq!(&black[..4], &[16, 16, 16, 16]);
        let white = convert(2, 2, &solid(2, 2, 255, 255, 255));
        assert_eq!(&white[..4], &[235, 235, 235, 235]);
    }

    #[test]
    fn a_neutral_frame_has_neutral_chroma() {
        // Grey must sit at chroma 128 in both planes — any drift here
        // is a colour cast across the whole recording.
        let grey = convert(2, 2, &solid(2, 2, 128, 128, 128));
        assert_eq!(&grey[4..6], &[128, 128]);
    }

    #[test]
    fn primaries_push_chroma_the_right_way() {
        // Blue is the classic channel-order tripwire: if BGRA were read
        // as RGBA, "blue" would come out red and these two assertions
        // would swap. U (Cb) is the blue-difference channel, V (Cr) the
        // red-difference one.
        let blue = convert(2, 2, &solid(2, 2, 0, 0, 255));
        let (u, v) = (blue[4], blue[5]);
        assert!(u > 128, "blue must raise Cb, got {u}");
        assert!(v < 128, "blue must lower Cr, got {v}");

        let red = convert(2, 2, &solid(2, 2, 255, 0, 0));
        let (u, v) = (red[4], red[5]);
        assert!(v > 128, "red must raise Cr, got {v}");
        assert!(u < 128, "red must lower Cb, got {u}");
    }

    #[test]
    fn luma_tracks_perceptual_weighting() {
        // BT.709 weights green far above red above blue. A converter
        // using the wrong matrix (BT.601, or unweighted) fails here.
        let green = convert(2, 2, &solid(2, 2, 0, 255, 0))[0];
        let red = convert(2, 2, &solid(2, 2, 255, 0, 0))[0];
        let blue = convert(2, 2, &solid(2, 2, 0, 0, 255))[0];
        assert!(green > red && red > blue, "{green} > {red} > {blue}");
    }

    #[test]
    fn chroma_averages_the_whole_block_not_one_corner() {
        // A 2×2 block of one red pixel and three black ones. Point
        // sampling the top-left would report full red; averaging
        // reports a quarter of it. This is the difference that makes
        // thin coloured UI lines fringe.
        let mut src = solid(2, 2, 0, 0, 0);
        src[0..4].copy_from_slice(&[0, 0, 255, 255]); // BGRA red at (0,0)
        let nv12 = convert(2, 2, &src);
        let v = nv12[5] as i32;
        let full_red = convert(2, 2, &solid(2, 2, 255, 0, 0))[5] as i32;
        assert!(v > 128, "the block is reddish");
        assert!(
            v < 128 + (full_red - 128) / 2,
            "a quarter-red block must not read as strongly red: {v} vs {full_red}"
        );
    }

    #[test]
    fn every_row_is_converted_not_just_the_first() {
        // Top half white, bottom half black — catches a stride bug that
        // would leave the tail of the luma plane untouched.
        let (w, h) = (4u32, 4u32);
        let mut src = solid(w, h, 255, 255, 255);
        let half = (w * h / 2 * 4) as usize;
        for byte in src[half..].iter_mut() {
            *byte = 0;
        }
        let nv12 = convert(w, h, &src);
        assert_eq!(nv12[0], 235, "first row is white");
        assert_eq!(
            nv12[(w * h - 1) as usize],
            16,
            "last row is black, so the whole plane was written"
        );
    }

    #[test]
    fn both_channel_orders_describe_the_same_colour() {
        // The same red pixel written in each order must convert
        // identically. If it doesn't, one of the two paths has red and
        // blue swapped — the failure mode that makes a recording look
        // like a photo negative of itself.
        let bgra: Vec<u8> = [0u8, 0, 255, 255].repeat(4); // B,G,R,A
        let rgba: Vec<u8> = [255u8, 0, 0, 255].repeat(4); // R,G,B,A

        let mut from_bgra = vec![0u8; nv12_len(2, 2)];
        let mut from_rgba = vec![0u8; nv12_len(2, 2)];
        assert!(to_nv12(&bgra, &mut from_bgra, 2, 2, PixelOrder::Bgra));
        assert!(to_nv12(&rgba, &mut from_rgba, 2, 2, PixelOrder::Rgba));
        assert_eq!(from_bgra, from_rgba);

        // …and reading one as the other must NOT agree, or the test
        // above would pass for a converter that ignores the order.
        let mut misread = vec![0u8; nv12_len(2, 2)];
        assert!(to_nv12(&bgra, &mut misread, 2, 2, PixelOrder::Rgba));
        assert_ne!(from_bgra, misread);
    }

    #[test]
    fn geometry_mismatches_are_refused_rather_than_read_past_the_end() {
        let src = solid(4, 4, 0, 0, 0);
        let mut dst = vec![0u8; nv12_len(4, 4)];
        let order = PixelOrder::Bgra;
        // Source too small for the declared size.
        assert!(!to_nv12(&src, &mut dst, 8, 8, order));
        // Destination too small.
        let mut small = vec![0u8; 4];
        assert!(!to_nv12(&src, &mut small, 4, 4, order));
        // Odd dimensions have no NV12 representation.
        let odd = solid(3, 3, 0, 0, 0);
        let mut odd_dst = vec![0u8; 32];
        assert!(!to_nv12(&odd, &mut odd_dst, 3, 3, order));
        // Zero area.
        assert!(!to_nv12(&src, &mut dst, 0, 0, order));
    }
}
