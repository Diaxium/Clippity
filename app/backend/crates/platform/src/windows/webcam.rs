//! Video-capture devices — enumeration and frame reads (ADR 0033).
//!
//! Shaped after [`super::media_reader`], and for the same reason ADR 0031
//! chose Media Foundation to encode: the platform already ships what this
//! needs. A camera is an `IMFMediaSource` like a file is, so
//! `MFCreateSourceReaderFromMediaSource` gives back the same
//! `IMFSourceReader` the decoder already drives, and asking it for RGB32
//! makes Media Foundation insert whatever converter the camera's native
//! format (usually NV12, MJPG or YUY2) requires. Nothing is added to the
//! installer.
//!
//! **Frames come out BGRA, and say so.** `MFVideoFormat_RGB32` is BGRA in
//! memory on Windows; rather than pay a channel swap here, the order
//! travels with the pixels the way `SinkFrame` does, and the compositor
//! aligns once per delivered camera frame instead of once per recorded
//! frame.
//!
//! **Threading.** Same rule as the rest of the Media Foundation surface:
//! COM objects are `!Send`, so a [`Webcam`] is created, read and dropped
//! on one thread. The recorder's compositor gives it a thread of its own
//! (a camera's cadence is its own, and blocking the frame loop on a
//! camera read would make the recording's frame rate a function of the
//! camera's).

use windows::core::PWSTR;
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFAttributes, IMFMediaSource, IMFMediaType, IMFSourceReader, MFCreateAttributes,
    MFCreateMediaType, MFCreateSourceReaderFromMediaSource, MFEnumDeviceSources, MFMediaType_Video,
    MFVideoFormat_RGB32, MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, MF_MT_DEFAULT_STRIDE,
    MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_READWRITE_DISABLE_CONVERTERS,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM,
};

use clippity_domain::pixels::PixelOrder;
use clippity_infra::error::{AppError, AppResult};

/// A camera the user can pick, for the sources UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebcamInfo {
    /// Symbolic link — the stable id a source pins. Opaque and long;
    /// never shown.
    pub id: String,
    pub name: String,
}

/// Every video-capture device currently attached.
///
/// An empty list is a valid answer — a machine with no camera is a
/// configuration, not an error — and is what the sources UI renders as
/// "no cameras found" rather than as a failure.
pub fn list_devices() -> AppResult<Vec<WebcamInfo>> {
    let attributes = vidcap_attributes()?;

    let mut raw: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    // SAFETY: `attributes` asks for video-capture devices; both
    // out-params are initialised and the array is freed below.
    unsafe { MFEnumDeviceSources(&attributes, &mut raw, &mut count) }
        .map_err(|e| AppError::Recorder(format!("could not list cameras: {e}")))?;
    if raw.is_null() {
        return Ok(Vec::new());
    }

    let mut out = Vec::with_capacity(count as usize);
    for index in 0..count as usize {
        // SAFETY: `raw` points at `count` activation objects, and each
        // slot is read exactly once.
        let slot = unsafe { &*raw.add(index) };
        if let Some(activate) = slot.as_ref() {
            if let (Some(id), name) = (
                attribute_string(
                    activate,
                    &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
                ),
                attribute_string(activate, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME),
            ) {
                out.push(WebcamInfo {
                    name: name.unwrap_or_else(|| "Camera".to_string()),
                    id,
                });
            }
        }
    }

    // SAFETY: the array itself was allocated by MFEnumDeviceSources with
    // CoTaskMemAlloc; the IMFActivate references inside it are owned by
    // the `Option<IMFActivate>` values, which drop with the read above.
    unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(raw as *const _)) };
    Ok(out)
}

/// An open camera, delivering BGRA frames.
pub struct Webcam {
    reader: IMFSourceReader,
    width: u32,
    height: u32,
    /// Negative means the rows arrive bottom-up — the same trap
    /// `media_reader` documents. Cameras report this more often than
    /// files do, because an RGB32 conversion of a bottom-up native
    /// format inherits the orientation.
    stride: i32,
}

// The reader is a COM interface, which `windows-rs` leaves `!Send`. The
// compositor's camera thread creates this, reads it and drops it, and
// nothing about it crosses a thread boundary — only the decoded frames
// do, as plain `Vec<u8>`.
unsafe impl Send for Webcam {}

impl Webcam {
    /// Open `device_id`, or the first camera when `None`.
    ///
    /// Following the first device rather than a documented "default"
    /// because Media Foundation has no default-camera concept the way
    /// WASAPI has a default endpoint. A pinned id that no longer
    /// resolves falls back to the first camera with a warning rather
    /// than failing — the same degradation rule the audio path uses for
    /// an unplugged microphone.
    pub fn open(device_id: Option<&str>) -> AppResult<Self> {
        let devices = list_devices()?;
        if devices.is_empty() {
            return Err(AppError::Recorder("no camera is attached".into()));
        }
        let chosen = match device_id {
            Some(id) => devices.iter().find(|d| d.id == id).unwrap_or_else(|| {
                tracing::warn!("the pinned camera is gone; using the first available");
                &devices[0]
            }),
            None => &devices[0],
        };

        let source = activate(&chosen.id)?;
        let reader = source_reader(&source)?;

        // Ask for RGB32 and let Media Foundation insert the converter —
        // the same negotiation `media_reader::Decoder::open` does, and
        // the reason a camera's native NV12/MJPG/YUY2 never reaches this
        // module.
        let want = uncompressed_rgb32()?;
        // SAFETY: a fully-populated uncompressed media type on the
        // reader's first video stream.
        unsafe {
            reader.SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &want)
        }
        .map_err(|e| {
            AppError::Recorder(format!("this camera's format cannot be converted: {e}"))
        })?;

        // Read geometry back from the *negotiated* type: the converter
        // is entitled to hand back a different size or a padded stride.
        let negotiated = current_type(&reader)?;
        let (width, height) = frame_size(&negotiated)
            .ok_or_else(|| AppError::Recorder("the camera stated no frame size".into()))?;
        let attrs: &IMFAttributes = (&negotiated).into();
        // SAFETY: reading an optional INT32 attribute.
        let stride = unsafe { attrs.GetUINT32(&MF_MT_DEFAULT_STRIDE) }
            .map(|v| v as i32)
            .unwrap_or((width * 4) as i32);

        Ok(Self {
            reader,
            width,
            height,
            stride,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Channel order of the frames [`Self::read`] produces.
    pub fn order(&self) -> PixelOrder {
        PixelOrder::Bgra
    }

    /// Next frame as tightly packed, top-down BGRA, or `None` when the
    /// camera produced nothing this call.
    ///
    /// `None` is ordinary rather than terminal: a camera delivers on its
    /// own cadence, and a read that arrives between frames is a wait, not
    /// an end. The caller keeps showing the previous image.
    pub fn read(&mut self, recycle: Option<Vec<u8>>) -> AppResult<Option<Vec<u8>>> {
        let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
        let mut flags = 0u32;
        let mut timestamp = 0i64;
        let mut sample = None;
        // SAFETY: out-params are initialised and live for the call.
        unsafe {
            self.reader.ReadSample(
                stream,
                0,
                None,
                Some(&mut flags),
                Some(&mut timestamp),
                Some(&mut sample),
            )
        }
        .map_err(|e| AppError::Recorder(format!("camera read failed: {e}")))?;

        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            return Ok(None);
        }
        let Some(sample) = sample else {
            // A format change or a gap notification — no pixels this
            // time, which is not a failure.
            return Ok(None);
        };

        let packed = copy_sample(&sample)?;
        Ok(Some(self.pack(&packed, recycle)?))
    }

    /// Copy the negotiated buffer into a tightly packed, top-down one,
    /// honouring a negative stride.
    ///
    /// Guessing the orientation instead would produce a webcam overlay
    /// that is silently upside down — valid pixels, wrong picture, and
    /// exactly the trap `media_reader` calls out on the decode side.
    fn pack(&self, packed: &[u8], recycle: Option<Vec<u8>>) -> AppResult<Vec<u8>> {
        let width = self.width as usize;
        let height = self.height as usize;
        let row_bytes = width * 4;
        let stride = self.stride.unsigned_abs() as usize;
        let bottom_up = self.stride < 0;

        if stride < row_bytes || packed.len() < stride * height {
            return Err(AppError::Recorder(format!(
                "camera frame is {} bytes, too small for {width}×{height} at stride {stride}",
                packed.len()
            )));
        }

        let mut out = recycle.unwrap_or_default();
        out.clear();
        out.reserve(row_bytes * height);
        for y in 0..height {
            let source_row = if bottom_up { height - 1 - y } else { y };
            let start = source_row * stride;
            out.extend_from_slice(&packed[start..start + row_bytes]);
        }
        Ok(out)
    }
}

/// An attribute store asking for video-capture devices.
fn vidcap_attributes() -> AppResult<IMFAttributes> {
    let mut store: Option<IMFAttributes> = None;
    // SAFETY: out-pointer to a local Option; the size is a hint.
    unsafe { MFCreateAttributes(&mut store, 1) }
        .map_err(|e| AppError::Recorder(format!("attribute store: {e}")))?;
    let attributes =
        store.ok_or_else(|| AppError::Recorder("attribute store came back empty".into()))?;
    // SAFETY: the documented device-source selector.
    unsafe {
        attributes.SetGUID(
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
        )
    }
    .map_err(|e| AppError::Recorder(format!("could not ask for cameras: {e}")))?;
    Ok(attributes)
}

/// Activate the device with this symbolic link.
fn activate(symbolic_link: &str) -> AppResult<IMFMediaSource> {
    let attributes = vidcap_attributes()?;
    let mut wide: Vec<u16> = symbolic_link.encode_utf16().collect();
    wide.push(0);
    // SAFETY: the symbolic-link key expects a NUL-terminated UTF-16
    // string that outlives the call.
    unsafe {
        attributes.SetString(
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
            windows::core::PCWSTR(wide.as_ptr()),
        )
    }
    .map_err(|e| AppError::Recorder(format!("could not pin the camera: {e}")))?;

    let mut raw: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    // SAFETY: as in `list_devices`.
    unsafe { MFEnumDeviceSources(&attributes, &mut raw, &mut count) }
        .map_err(|e| AppError::Recorder(format!("could not open the camera: {e}")))?;
    if raw.is_null() || count == 0 {
        return Err(AppError::Recorder(
            "that camera is no longer attached".into(),
        ));
    }
    // SAFETY: at least one activation object was returned.
    let first = unsafe { (*raw).clone() };
    // SAFETY: frees the array; the cloned reference above outlives it.
    unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(raw as *const _)) };

    let activate =
        first.ok_or_else(|| AppError::Recorder("the camera would not activate".into()))?;
    // SAFETY: activating a device source returns its IMFMediaSource.
    unsafe { activate.ActivateObject::<IMFMediaSource>() }.map_err(|e| {
        AppError::Recorder(format!(
            "the camera is unavailable — another app may be using it: {e}"
        ))
    })
}

/// A source reader over an already-activated media source, with the
/// video processor enabled so RGB32 can be negotiated.
fn source_reader(source: &IMFMediaSource) -> AppResult<IMFSourceReader> {
    let mut store: Option<IMFAttributes> = None;
    // SAFETY: out-pointer to a local Option.
    unsafe { MFCreateAttributes(&mut store, 2) }
        .map_err(|e| AppError::Recorder(format!("attribute store: {e}")))?;
    let attributes =
        store.ok_or_else(|| AppError::Recorder("attribute store came back empty".into()))?;
    // SAFETY: documented source-reader attributes.
    unsafe {
        attributes
            .SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)
            // The converter is the whole point; refusing it would leave
            // the camera's native NV12/MJPG for this module to decode
            // itself.
            .and_then(|_| attributes.SetUINT32(&MF_READWRITE_DISABLE_CONVERTERS, 0))
    }
    .map_err(|e| AppError::Recorder(format!("could not configure the camera reader: {e}")))?;

    // SAFETY: a valid media source and a populated attribute store.
    unsafe { MFCreateSourceReaderFromMediaSource(source, &attributes) }
        .map_err(|e| AppError::Recorder(format!("could not read from the camera: {e}")))
}

fn uncompressed_rgb32() -> AppResult<IMFMediaType> {
    // SAFETY: allocates an empty media type.
    let media_type = unsafe { MFCreateMediaType() }
        .map_err(|e| AppError::Recorder(format!("could not describe a media type: {e}")))?;
    let attrs: &IMFAttributes = (&media_type).into();
    // SAFETY: standard major/subtype keys.
    unsafe {
        attrs
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .and_then(|_| attrs.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32))
    }
    .map_err(|e| AppError::Recorder(format!("could not describe a media type: {e}")))?;
    Ok(media_type)
}

fn current_type(reader: &IMFSourceReader) -> AppResult<IMFMediaType> {
    // SAFETY: reading the negotiated type of a valid stream.
    unsafe { reader.GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32) }
        .map_err(|e| AppError::Recorder(format!("the camera stream vanished: {e}")))
}

fn frame_size(media_type: &IMFMediaType) -> Option<(u32, u32)> {
    let attrs: &IMFAttributes = media_type.into();
    // SAFETY: reading a packed UINT64 attribute.
    let packed = unsafe { attrs.GetUINT64(&MF_MT_FRAME_SIZE) }.ok()?;
    Some(((packed >> 32) as u32, packed as u32))
}

/// Copy a sample's single buffer out to a plain `Vec`.
fn copy_sample(sample: &windows::Win32::Media::MediaFoundation::IMFSample) -> AppResult<Vec<u8>> {
    // SAFETY: a sample from ReadSample always has at least one buffer.
    let buffer = unsafe { sample.ConvertToContiguousBuffer() }
        .map_err(|e| AppError::Recorder(format!("camera buffer: {e}")))?;

    let mut data: *mut u8 = std::ptr::null_mut();
    let mut len = 0u32;
    // SAFETY: Lock hands back a pointer valid until Unlock, which the
    // copy below is bounded by.
    unsafe { buffer.Lock(&mut data, None, Some(&mut len)) }
        .map_err(|e| AppError::Recorder(format!("camera buffer lock: {e}")))?;
    // SAFETY: `data`/`len` describe the locked region.
    let copied = unsafe { std::slice::from_raw_parts(data, len as usize) }.to_vec();
    // SAFETY: balances the Lock above.
    let _ = unsafe { buffer.Unlock() };
    Ok(copied)
}

/// Read a string attribute off an activation object.
fn attribute_string(activate: &IMFActivate, key: &windows::core::GUID) -> Option<String> {
    let mut raw = PWSTR::null();
    let mut len = 0u32;
    // SAFETY: allocates a string the caller frees; both out-params are
    // initialised.
    unsafe { activate.GetAllocatedString(key, &mut raw, &mut len) }.ok()?;
    if raw.is_null() {
        return None;
    }
    // SAFETY: `raw` is a NUL-terminated UTF-16 string of `len` chars.
    let value = unsafe { raw.to_string() }.ok();
    // SAFETY: frees what GetAllocatedString allocated.
    unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(raw.0 as *const _)) };
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Enumerates the real cameras on this machine.
    ///
    /// `#[ignore]`d for the same reason ADR 0031's four are: it needs a
    /// Windows session with the device stack present, and a machine with
    /// no camera would fail it for the wrong reason. Run with
    /// `cargo test -p clippity-platform -- --ignored`.
    #[test]
    #[ignore = "needs a Windows session with a camera attached"]
    fn lists_the_real_cameras_on_this_machine() {
        let _com = super::super::media_foundation::ComThread::init().expect("COM starts");
        let devices = list_devices().expect("enumeration succeeds");
        println!("{} camera(s)", devices.len());
        for d in &devices {
            println!("  {} ({})", d.name, d.id);
            assert!(!d.id.is_empty(), "a camera with no symbolic link");
            assert!(!d.name.is_empty(), "a camera with no name");
        }
    }

    /// Opens the first camera and reads real frames through the real
    /// converter — the part that compiles perfectly and fails at
    /// runtime, exactly like media-type negotiation on the encode side.
    #[test]
    #[ignore = "needs a Windows session with a camera attached"]
    fn reads_packed_bgra_frames_from_a_real_camera() {
        let _com = super::super::media_foundation::ComThread::init().expect("COM starts");
        if list_devices().expect("enumeration").is_empty() {
            println!("no camera attached — nothing to read");
            return;
        }

        let mut cam = Webcam::open(None).expect("the first camera opens");
        assert!(cam.width() > 0 && cam.height() > 0);
        let expected = cam.width() as usize * cam.height() as usize * 4;

        // Cameras take a moment to deliver; a few empty reads are
        // ordinary rather than a failure.
        let mut frames = 0;
        let mut recycle = None;
        for _ in 0..120 {
            match cam.read(recycle.take()).expect("a read succeeds") {
                Some(frame) => {
                    assert_eq!(frame.len(), expected, "frame is not tightly packed");
                    frames += 1;
                    recycle = Some(frame);
                    if frames >= 3 {
                        break;
                    }
                }
                None => std::thread::sleep(std::time::Duration::from_millis(10)),
            }
        }
        assert!(frames > 0, "the camera never delivered a frame");
        assert_eq!(cam.order(), PixelOrder::Bgra);
    }
}
