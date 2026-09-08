//! HDR still-image encoding.
//!
//! The desktop arrives as linear scRGB. This module converts it to the
//! interoperable HDR PNG representation defined by PNG Third Edition:
//! 16-bit full-range RGB, BT.2020 primaries, PQ transfer, plus cICP,
//! mDCV and cLLI chunks. The ordinary PNG path remains the SDR export.

use clippity_domain::hdr::{self, Hdr10Metadata};
use clippity_domain::settings::CaptureCompression;
use clippity_infra::error::{AppError, AppResult};

/// Encode tightly packed linear-scRGB RGBA floats as HDR10 PNG.
pub fn encode_hdr_png(
    pixels: &[f32],
    width: u32,
    height: u32,
    compression: CaptureCompression,
) -> AppResult<Vec<u8>> {
    let frame = hdr::hdr10_rgb16_frame(pixels, width, height);
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Sixteen);
    encoder.set_compression(match compression {
        CaptureCompression::Fast => png::Compression::Fast,
        CaptureCompression::Balanced => png::Compression::Balanced,
        CaptureCompression::Small => png::Compression::High,
    });

    let mut writer = encoder
        .write_header()
        .map_err(|e| AppError::Capture(format!("HDR png header: {e}")))?;
    // ITU-T H.273 code points: BT.2020 primaries (9), PQ/ST 2084
    // transfer (16), identity matrix for RGB (0), full range (1).
    writer
        .write_chunk(png::chunk::cICP, &[9, 16, 0, 1])
        .map_err(|e| AppError::Capture(format!("HDR png cICP: {e}")))?;
    writer
        .write_chunk(png::chunk::mDCV, &mastering_display_chunk())
        .map_err(|e| AppError::Capture(format!("HDR png mDCV: {e}")))?;
    writer
        .write_chunk(png::chunk::cLLI, &content_light_chunk(frame.metadata))
        .map_err(|e| AppError::Capture(format!("HDR png cLLI: {e}")))?;
    writer
        .write_image_data(&frame.pixels)
        .map_err(|e| AppError::Capture(format!("HDR png pixels: {e}")))?;
    drop(writer);
    Ok(bytes)
}

/// SMPTE ST 2086 mastering display metadata for the BT.2020/PQ coding
/// volume. Chromaticities use 0.00002 units and luminance 0.0001 nit.
fn mastering_display_chunk() -> [u8; 24] {
    let fields: [u16; 8] = [
        35_400, 14_600, // R 0.708, 0.292
        8_500, 39_850, // G 0.170, 0.797
        6_550, 2_300, // B 0.131, 0.046
        15_635, 16_450, // D65 0.3127, 0.3290
    ];
    let mut out = [0u8; 24];
    for (i, value) in fields.into_iter().enumerate() {
        out[i * 2..i * 2 + 2].copy_from_slice(&value.to_be_bytes());
    }
    out[16..20].copy_from_slice(&100_000_000u32.to_be_bytes()); // 10,000 nit
    out[20..24].copy_from_slice(&1u32.to_be_bytes()); // 0.0001 nit
    out
}

fn content_light_chunk(metadata: Hdr10Metadata) -> [u8; 8] {
    fn fixed(nits: f32) -> u32 {
        if nits.is_finite() {
            (nits.clamp(0.0, hdr::PQ_PEAK_NITS) * 10_000.0 + 0.5) as u32
        } else {
            0
        }
    }
    let mut out = [0u8; 8];
    out[..4].copy_from_slice(&fixed(metadata.max_cll).to_be_bytes());
    out[4..].copy_from_slice(&fixed(metadata.max_fall).to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn encoded_png_is_16_bit_bt2020_pq_with_hdr_metadata() {
        let pixels = [2.5, 2.5, 2.5, 1.0, 12.5, 12.5, 12.5, 1.0];
        let bytes = encode_hdr_png(&pixels, 2, 1, CaptureCompression::Fast).unwrap();
        let decoder = png::Decoder::new(Cursor::new(bytes));
        let reader = decoder.read_info().unwrap();
        let info = reader.info();
        assert_eq!(info.bit_depth, png::BitDepth::Sixteen);
        assert_eq!(info.color_type, png::ColorType::Rgb);
        let cicp = info.coding_independent_code_points.unwrap();
        assert_eq!(cicp.color_primaries, 9);
        assert_eq!(cicp.transfer_function, 16);
        assert_eq!(cicp.matrix_coefficients, 0);
        assert!(cicp.is_video_full_range_image);
        assert!(info.mastering_display_color_volume.is_some());
        let light = info.content_light_level.unwrap();
        assert!(light.max_content_light_level.abs_diff(10_000_000) < 16);
        assert!(light.max_frame_average_light_level.abs_diff(6_000_000) < 16);
    }
}
