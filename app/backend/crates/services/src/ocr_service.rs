//! Grab-Text OCR — runs Windows.Media.Ocr against a cropped region and
//! returns the recognized plaintext. The engine is resolved from the
//! user's profile languages so the input language matches what they read
//! day to day (ADR 0007).
//!
//! Pipeline (Windows):
//!   1. PNG-encode the cropped `RgbaImage` in memory.
//!   2. Hand the bytes to a WinRT `InMemoryRandomAccessStream`.
//!   3. `BitmapDecoder` → `SoftwareBitmap` (BGRA8, premultiplied).
//!   4. `OcrEngine.RecognizeAsync` → `OcrResult.Text`.
//!
//! The WinRT async ops are driven through `tauri::async_runtime::block_on`
//! so callers see a synchronous `fn` and need no executor. COM is
//! initialized on the calling thread first (commands land on worker
//! threads where it isn't). Non-Windows targets get a stub that errors.

/// Recognize the text in `image`, returning the engine's concatenated
/// plaintext (untrimmed). `Err` on an empty image, a missing OCR
/// language pack, or any WinRT failure — the caller maps it to a
/// user-facing error.
#[cfg(target_os = "windows")]
pub fn recognize(image: &image::RgbaImage) -> Result<String, String> {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    if image.width() == 0 || image.height() == 0 {
        return Err("empty image".into());
    }

    // Tauri commands can land on worker threads where COM isn't init'd.
    // RPC_E_CHANGED_MODE is fine — COM was already initialized under a
    // different model, and Media.Ocr works either way.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let image = image.clone();
    tauri::async_runtime::block_on(recognize_async(image))
}

#[cfg(target_os = "windows")]
async fn recognize_async(image: image::RgbaImage) -> Result<String, String> {
    use std::io::Cursor;

    use image::ImageFormat;
    use windows::Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, SoftwareBitmap,
    };
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    // ----- PNG encode -----
    let mut png = Vec::with_capacity(64 * 1024);
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .map_err(|e| format!("png encode: {e}"))?;

    // ----- bytes → IRandomAccessStream -----
    let stream = InMemoryRandomAccessStream::new().map_err(|e| format!("ocr stream new: {e}"))?;
    {
        let writer =
            DataWriter::CreateDataWriter(&stream).map_err(|e| format!("ocr writer new: {e}"))?;
        writer
            .WriteBytes(&png)
            .map_err(|e| format!("ocr writer write: {e}"))?;
        writer
            .StoreAsync()
            .map_err(|e| format!("ocr writer store: {e}"))?
            .await
            .map_err(|e| format!("ocr writer store await: {e}"))?;
        writer
            .FlushAsync()
            .map_err(|e| format!("ocr writer flush: {e}"))?
            .await
            .map_err(|e| format!("ocr writer flush await: {e}"))?;
        writer
            .DetachStream()
            .map_err(|e| format!("ocr writer detach: {e}"))?;
    }
    stream
        .Seek(0)
        .map_err(|e| format!("ocr stream seek: {e}"))?;

    // ----- decode → SoftwareBitmap (BGRA8 premultiplied) -----
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| format!("decoder create: {e}"))?
        .await
        .map_err(|e| format!("decoder await: {e}"))?;
    let raw_bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| format!("get bitmap: {e}"))?
        .await
        .map_err(|e| format!("get bitmap await: {e}"))?;
    let bitmap = SoftwareBitmap::ConvertWithAlpha(
        &raw_bitmap,
        BitmapPixelFormat::Bgra8,
        BitmapAlphaMode::Premultiplied,
    )
    .map_err(|e| format!("bitmap convert: {e}"))?;

    // ----- OCR -----
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| "no OCR language pack is installed for your display languages".to_string())?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("recognize: {e}"))?
        .await
        .map_err(|e| format!("recognize await: {e}"))?;
    let text = result.Text().map_err(|e| format!("ocr text: {e}"))?;
    Ok(text.to_string_lossy())
}

/// Non-Windows stub — Media.Ocr is Windows-only. A macOS Vision / Linux
/// Tesseract backend would replace this (ADR 0007 follow-up).
#[cfg(not(target_os = "windows"))]
pub fn recognize(_image: &image::RgbaImage) -> Result<String, String> {
    Err("OCR is only available on Windows".into())
}
