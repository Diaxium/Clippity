//! Byte order of a 32-bit pixel, and nothing else.
//!
//! A captured frame is four bytes per pixel wherever it came from, but
//! *which* four differs by source: `xcap` and the video decoder hand back
//! RGBA, while every raw Win32 surface — a GDI DIB, a Desktop Duplication
//! read-back — is BGRA. The two are indistinguishable by inspection, so a
//! frame that travels without saying which it is arrives somewhere that
//! guesses, and a wrong guess swaps red with blue in the finished file.
//!
//! This lives in the domain rather than beside the converter that reads
//! it because the *sinks* now carry it: a recording session hands the
//! encoder whatever order the capture produced instead of paying a pass
//! over every pixel to normalise it first (see
//! `services::recorder_service::sink::SinkFrame`). The sink trait is not
//! platform-gated, so neither can this be.

/// Which of a 4-byte pixel's channels is red and which is blue.
///
/// Green is at index 1 and alpha at index 3 in both orders, so the two
/// differ only by a swap of the outer pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelOrder {
    /// Blue, green, red, alpha — Win32's native surface order.
    Bgra,
    /// Red, green, blue, alpha — what `xcap` and the decoder hand back.
    Rgba,
}

impl PixelOrder {
    /// Offsets of (red, blue) within a 4-byte pixel.
    ///
    /// The form every per-pixel loop wants: two indices to read through,
    /// rather than a branch per pixel on the order itself.
    pub fn red_blue(self) -> (usize, usize) {
        match self {
            PixelOrder::Bgra => (2, 0),
            PixelOrder::Rgba => (0, 2),
        }
    }

    /// The other order — what reading a frame in this one as the other
    /// would produce.
    pub fn swapped(self) -> Self {
        match self {
            PixelOrder::Bgra => PixelOrder::Rgba,
            PixelOrder::Rgba => PixelOrder::Bgra,
        }
    }
}

/// Swap red and blue in place, turning BGRA into RGBA or back.
///
/// For the one consumer that genuinely needs a particular order — the
/// GIF encoder, which quantizes through `image`'s RGBA types. Every
/// other path carries the order instead, because this is a whole extra
/// pass over the frame and passes over a frame are what a recording's
/// budget is made of.
///
/// Operates on whole pixels; a trailing partial pixel is left alone
/// rather than read past.
pub fn swap_red_blue(pixels: &mut [u8]) {
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_orders_disagree_about_red_and_blue_only() {
        assert_eq!(PixelOrder::Rgba.red_blue(), (0, 2));
        assert_eq!(PixelOrder::Bgra.red_blue(), (2, 0));
    }

    #[test]
    fn swapping_an_order_twice_is_the_identity() {
        assert_eq!(PixelOrder::Rgba.swapped().swapped(), PixelOrder::Rgba);
        assert_eq!(PixelOrder::Bgra.swapped(), PixelOrder::Rgba);
    }

    #[test]
    fn swapping_channels_agrees_with_swapping_the_order() {
        // The same red pixel in each order. Swapping the bytes of one
        // must produce the other — if it doesn't, a GIF written from a
        // BGRA capture comes out as its own colour negative.
        let mut bgra = [0u8, 0, 255, 255];
        swap_red_blue(&mut bgra);
        assert_eq!(bgra, [255, 0, 0, 255]);
    }

    #[test]
    fn a_trailing_partial_pixel_is_left_alone_rather_than_read_past() {
        let mut ragged = [0u8, 0, 255, 255, 9, 9];
        swap_red_blue(&mut ragged);
        assert_eq!(ragged, [255, 0, 0, 255, 9, 9]);
    }
}
