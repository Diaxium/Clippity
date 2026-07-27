//! Optional cursor compositing — xcap on Windows uses
//! `Windows.Graphics.Capture` with `SetIsCursorCaptureEnabled(false)`,
//! so we paint the system cursor onto the captured `RgbaImage`
//! ourselves when the user toggles "include cursor" on.
//!
//! Implementation note: GDI's `DrawIconEx` on a 32-bit DIB does NOT
//! reliably write the alpha channel — most cursor types leave alpha
//! at zero, which makes the result invisible if we trust the alpha
//! as-is. We render the cursor onto two buffers (one pre-filled
//! black, one pre-filled white) and derive alpha from the
//! per-channel difference: identical pixels are fully opaque cursor,
//! pixels that picked up the background color are
//! (semi-)transparent. Same code path works for color *and*
//! monochrome cursors, including the antialiased Windows 11 default
//! arrow.
//!
//! This file is `cfg(target_os = "windows")` only — gated at the
//! parent `platform::mod` so callers don't need to wrap their
//! invocations.

use image::RgbaImage;

/// Current system cursor position in virtual-screen physical pixels.
pub fn screen_position() -> Option<(i32, i32)> {
    use std::mem::size_of;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorInfo, CURSORINFO, CURSORINFO_FLAGS};

    unsafe {
        let mut ci = CURSORINFO {
            cbSize: size_of::<CURSORINFO>() as u32,
            flags: CURSORINFO_FLAGS(0),
            hCursor: Default::default(),
            ptScreenPos: POINT { x: 0, y: 0 },
        };
        if GetCursorInfo(&mut ci).is_err() {
            return None;
        }
        Some((ci.ptScreenPos.x, ci.ptScreenPos.y))
    }
}

/// Composite the current system cursor onto `canvas`. `origin` is the
/// virtual-screen position of `canvas`'s `(0, 0)` pixel — e.g.
/// `min_x, min_y` from the stitched desktop canvas, or the primary
/// monitor's `(x, y)`.
///
/// `override_canvas_pos` lets the caller pin the cursor to a
/// canvas-local pixel position instead of using the live system
/// cursor's screen position. The region overlay uses this: at capture
/// time the user's mouse is on the floating Capture button, far
/// outside their selection, so we instead place the cursor at the
/// last position the user had inside the selection rect.
///
/// `clip_region` is a canvas-local `(x, y, w, h)` rectangle that the
/// caller wants the full cursor bitmap to land inside. When the
/// override puts the cursor's tip near (or past) a corner, the arrow
/// body would extend outside the crop and the user would see nothing
/// — so we shift the cursor inward enough that its bounding box
/// stays inside the clip.
pub fn composite_cursor(
    canvas: &mut RgbaImage,
    origin_x: i32,
    origin_y: i32,
    override_canvas_pos: Option<(i32, i32)>,
    clip_region: Option<(i32, i32, i32, i32)>,
) {
    use std::mem::size_of;
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetObjectW,
        ReleaseDC, SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HGDIOBJ, ROP_CODE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSORINFO_FLAGS, CURSOR_SHOWING,
        DI_NORMAL, HICON, ICONINFO,
    };

    // ROP codes that don't need a source DC.
    const BLACKNESS: ROP_CODE = ROP_CODE(0x00000042);
    const WHITENESS: ROP_CODE = ROP_CODE(0x00FF0062);

    unsafe {
        let mut ci = CURSORINFO {
            cbSize: size_of::<CURSORINFO>() as u32,
            flags: CURSORINFO_FLAGS(0),
            hCursor: Default::default(),
            ptScreenPos: POINT { x: 0, y: 0 },
        };
        if GetCursorInfo(&mut ci).is_err() {
            return;
        }
        if (ci.flags.0 & CURSOR_SHOWING.0) == 0 || ci.hCursor.is_invalid() {
            return;
        }
        let hicon = HICON(ci.hCursor.0);

        let mut ii = ICONINFO::default();
        if GetIconInfo(hicon, &mut ii).is_err() {
            return;
        }

        // Discover cursor pixel dimensions from whichever bitmap exists.
        let mut bm = BITMAP::default();
        let probe = if !ii.hbmColor.is_invalid() {
            HGDIOBJ(ii.hbmColor.0)
        } else {
            HGDIOBJ(ii.hbmMask.0)
        };
        if GetObjectW(
            probe,
            size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        ) == 0
        {
            free_icon_bitmaps(&ii);
            return;
        }
        let width = bm.bmWidth as u32;
        // Monochrome cursors stack the AND + XOR masks vertically in hbmMask.
        let height = if ii.hbmColor.is_invalid() {
            (bm.bmHeight / 2) as u32
        } else {
            bm.bmHeight as u32
        };
        if width == 0 || height == 0 {
            free_icon_bitmaps(&ii);
            return;
        }

        // Top-down 32-bit DIBs so we can read pixels directly as BGRA.
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let screen_dc = GetDC(None);
        let mem_dc = CreateCompatibleDC(Some(screen_dc));

        // Allocate two DIBs — both start zero-initialized by the OS.
        let mut bits_a: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut bits_b: *mut std::ffi::c_void = std::ptr::null_mut();
        let dib_a = CreateDIBSection(
            Some(screen_dc),
            &bmi,
            DIB_RGB_COLORS,
            &mut bits_a as *mut _,
            None,
            0,
        );
        let dib_b = CreateDIBSection(
            Some(screen_dc),
            &bmi,
            DIB_RGB_COLORS,
            &mut bits_b as *mut _,
            None,
            0,
        );
        let (dib_a, dib_b) = match (dib_a, dib_b) {
            (Ok(a), Ok(b)) => (a, b),
            (a, b) => {
                if let Ok(h) = a {
                    let _ = DeleteObject(HGDIOBJ(h.0));
                }
                if let Ok(h) = b {
                    let _ = DeleteObject(HGDIOBJ(h.0));
                }
                let _ = DeleteDC(mem_dc);
                ReleaseDC(Some(HWND::default()), screen_dc);
                free_icon_bitmaps(&ii);
                return;
            }
        };

        // Buffer A: pre-fill with black, then draw the cursor on top.
        let old = SelectObject(mem_dc, HGDIOBJ(dib_a.0));
        let _ = BitBlt(
            mem_dc,
            0,
            0,
            width as i32,
            height as i32,
            None,
            0,
            0,
            BLACKNESS,
        );
        let _ = DrawIconEx(
            mem_dc,
            0,
            0,
            hicon,
            width as i32,
            height as i32,
            0,
            None,
            DI_NORMAL,
        );

        // Buffer B: pre-fill with white, then draw the cursor on top.
        SelectObject(mem_dc, HGDIOBJ(dib_b.0));
        let _ = BitBlt(
            mem_dc,
            0,
            0,
            width as i32,
            height as i32,
            None,
            0,
            0,
            WHITENESS,
        );
        let _ = DrawIconEx(
            mem_dc,
            0,
            0,
            hicon,
            width as i32,
            height as i32,
            0,
            None,
            DI_NORMAL,
        );

        // Read both DIB buffers and derive alpha from their difference.
        let pixel_count = (width * height) as usize;
        let slice_a = std::slice::from_raw_parts(bits_a as *const u8, pixel_count * 4);
        let slice_b = std::slice::from_raw_parts(bits_b as *const u8, pixel_count * 4);

        let mut rgba: Vec<u8> = Vec::with_capacity(pixel_count * 4);
        for i in 0..pixel_count {
            // DIB layout is BGRA in memory.
            let ab = slice_a[i * 4];
            let ag = slice_a[i * 4 + 1];
            let ar = slice_a[i * 4 + 2];
            let bb = slice_b[i * 4];
            let bg = slice_b[i * 4 + 1];
            let br = slice_b[i * 4 + 2];

            // For each colour channel the white-background result minus the
            // black-background result is ≈ 255 * (1 - cursor_alpha). Average
            // across channels to absorb rounding noise from DrawIconEx.
            let diff_r = br.saturating_sub(ar) as u32;
            let diff_g = bg.saturating_sub(ag) as u32;
            let diff_b = bb.saturating_sub(ab) as u32;
            let avg_diff = ((diff_r + diff_g + diff_b) / 3) as u8;
            let alpha = 255u8.saturating_sub(avg_diff);

            if alpha == 0 {
                rgba.extend_from_slice(&[0, 0, 0, 0]);
            } else if alpha == 255 {
                // Cursor pixel is fully opaque — buffer A holds the exact
                // cursor colour (no background contribution).
                rgba.extend_from_slice(&[ar, ag, ab, 255]);
            } else {
                // Buffer A stores `src.rgb * (alpha/255)` (premultiplied);
                // un-premultiply to straight RGBA so
                // `image::imageops::overlay` can blend it correctly onto
                // the screenshot.
                let a32 = alpha as u32;
                let sr = ((ar as u32 * 255) / a32).min(255) as u8;
                let sg = ((ag as u32 * 255) / a32).min(255) as u8;
                let sb = ((ab as u32 * 255) / a32).min(255) as u8;
                rgba.extend_from_slice(&[sr, sg, sb, alpha]);
            }
        }

        // GDI cleanup.
        SelectObject(mem_dc, old);
        let _ = DeleteObject(HGDIOBJ(dib_a.0));
        let _ = DeleteObject(HGDIOBJ(dib_b.0));
        let _ = DeleteDC(mem_dc);
        ReleaseDC(Some(HWND::default()), screen_dc);
        free_icon_bitmaps(&ii);

        let Some(cursor_img) = RgbaImage::from_raw(width, height, rgba) else {
            return;
        };

        // Position on the canvas. Either use an explicit canvas-local
        // position from the caller (region overlay's `lastInSelection`
        // pin) or convert the system cursor's virtual-screen position
        // into canvas-local coordinates. Subtract the hotspot so the
        // cursor *tip* lands where the pointer logically is.
        let (mut dx, mut dy) = match override_canvas_pos {
            Some((cx, cy)) => (cx - ii.xHotspot as i32, cy - ii.yHotspot as i32),
            None => (
                ci.ptScreenPos.x - ii.xHotspot as i32 - origin_x,
                ci.ptScreenPos.y - ii.yHotspot as i32 - origin_y,
            ),
        };

        // When the caller pinned the cursor *and* gave us a clip region,
        // clamp the cursor's bounding box inside that region. Otherwise
        // a user releasing the drag at the bottom-right corner of their
        // selection ends up with a cursor whose entire body lives
        // outside the crop, leaving just a one-pixel tip visible.
        if override_canvas_pos.is_some() {
            if let Some((rx, ry, rw, rh)) = clip_region {
                let cw = width as i32;
                let ch = height as i32;
                let max_x = (rx + rw - cw).max(rx);
                let max_y = (ry + rh - ch).max(ry);
                dx = dx.max(rx).min(max_x);
                dy = dy.max(ry).min(max_y);
            }
        }

        image::imageops::overlay(canvas, &cursor_img, dx as i64, dy as i64);
    }
}

fn free_icon_bitmaps(ii: &windows::Win32::UI::WindowsAndMessaging::ICONINFO) {
    use windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};
    unsafe {
        if !ii.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
        }
        if !ii.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
        }
    }
}
