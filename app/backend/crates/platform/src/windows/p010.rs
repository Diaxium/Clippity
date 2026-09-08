//! Linear scRGB FP16 to HDR10 P010 conversion.
//!
//! P010 stores a 10-bit limited-range BT.2020/PQ 4:2:0 signal in the
//! high bits of 16-bit little-endian words. The conversion is kept here
//! (rather than delegated to an implicit MFT) so the bytes and metadata
//! handed to a Main10 encoder always describe the same color space.

use clippity_domain::hdr;

pub fn p010_len(width: u32, height: u32) -> usize {
    width as usize * height as usize * 3
}

/// Convert packed little-endian RGBA binary16 scRGB into packed P010.
/// Returns false without writing when dimensions/buffer lengths are bad.
pub fn to_p010_scrgb_f16(src: &[u8], dst: &mut [u8], width: u32, height: u32) -> bool {
    if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
        return false;
    }
    let pixels = width as usize * height as usize;
    if src.len() < pixels * 8 || dst.len() < p010_len(width, height) {
        return false;
    }

    let y_bytes = pixels * 2;
    for y in (0..height as usize).step_by(2) {
        for x in (0..width as usize).step_by(2) {
            let mut cb_sum = 0.0f32;
            let mut cr_sum = 0.0f32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let index = (y + dy) * width as usize + x + dx;
                    let [r, g, b] = read_pq_bt2020(src, index);
                    let (luma, cb, cr) = rgb_to_ycbcr(r, g, b);
                    write_word(dst, index * 2, limited_luma(luma) << 6);
                    cb_sum += cb;
                    cr_sum += cr;
                }
            }
            let chroma_index = (y / 2) * width as usize + x;
            write_word(
                dst,
                y_bytes + chroma_index * 2,
                limited_chroma(cb_sum * 0.25) << 6,
            );
            write_word(
                dst,
                y_bytes + (chroma_index + 1) * 2,
                limited_chroma(cr_sum * 0.25) << 6,
            );
        }
    }
    true
}

fn read_pq_bt2020(src: &[u8], pixel: usize) -> [f32; 3] {
    let at = pixel * 8;
    let half = |offset| {
        super::hdr_capture::f16_to_f32(u16::from_le_bytes([src[at + offset], src[at + offset + 1]]))
    };
    let rgb = hdr::linear_scrgb_to_bt2020(half(0), half(2), half(4));
    [
        hdr::nits_to_pq(rgb[0] * hdr::SCRGB_REFERENCE_WHITE_NITS),
        hdr::nits_to_pq(rgb[1] * hdr::SCRGB_REFERENCE_WHITE_NITS),
        hdr::nits_to_pq(rgb[2] * hdr::SCRGB_REFERENCE_WHITE_NITS),
    ]
}

fn rgb_to_ycbcr(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    const KR: f32 = 0.2627;
    const KG: f32 = 0.6780;
    const KB: f32 = 0.0593;
    let y = KR * r + KG * g + KB * b;
    (
        y,
        (b - y) / (2.0 * (1.0 - KB)),
        (r - y) / (2.0 * (1.0 - KR)),
    )
}

fn limited_luma(value: f32) -> u16 {
    (64.0 + 876.0 * value.clamp(0.0, 1.0) + 0.5) as u16
}

fn limited_chroma(value: f32) -> u16 {
    (512.0 + 896.0 * value.clamp(-0.5, 0.5) + 0.5) as u16
}

fn write_word(dst: &mut [u8], at: usize, value: u16) {
    dst[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn half(value: f32) -> [u8; 2] {
        // Test anchors only need exact zero/one/powers-of-two encodings.
        let bits = match value {
            0.0 => 0x0000,
            1.0 => 0x3c00,
            2.0 => 0x4000,
            4.0 => 0x4400,
            _ => panic!("unsupported test value"),
        };
        u16::to_le_bytes(bits)
    }

    fn solid(value: f32) -> Vec<u8> {
        let mut out = Vec::new();
        for _ in 0..4 {
            out.extend_from_slice(&half(value));
            out.extend_from_slice(&half(value));
            out.extend_from_slice(&half(value));
            out.extend_from_slice(&half(1.0));
        }
        out
    }

    fn word(bytes: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([bytes[at], bytes[at + 1]]) >> 6
    }

    #[test]
    fn black_uses_p010_studio_range_endpoints() {
        let mut out = vec![0; p010_len(2, 2)];
        assert!(to_p010_scrgb_f16(&solid(0.0), &mut out, 2, 2));
        assert_eq!(word(&out, 0), 64);
        assert_eq!(word(&out, 8), 512);
        assert_eq!(word(&out, 10), 512);
    }

    #[test]
    fn brighter_scrgb_values_remain_brighter_in_pq() {
        let mut white = vec![0; p010_len(2, 2)];
        let mut highlight = vec![0; p010_len(2, 2)];
        to_p010_scrgb_f16(&solid(1.0), &mut white, 2, 2);
        to_p010_scrgb_f16(&solid(4.0), &mut highlight, 2, 2);
        assert!(word(&highlight, 0) > word(&white, 0));
    }

    #[test]
    fn odd_or_short_frames_are_refused() {
        let mut out = vec![0; 32];
        assert!(!to_p010_scrgb_f16(&[], &mut out, 2, 2));
        assert!(!to_p010_scrgb_f16(&solid(1.0), &mut out, 3, 2));
    }
}
