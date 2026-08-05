//! WASAPI capture for the recorder's microphone and system-audio
//! tracks.
//!
//! Two sources, one API. A microphone is a *capture* endpoint opened
//! normally; system audio is a *render* endpoint opened with
//! `AUDCLNT_STREAMFLAGS_LOOPBACK`, which hands back what Windows just
//! mixed for the speakers. Both then look identical: poll for packets,
//! normalise to the encoder's PCM shape (`super::pcm`), hand up.
//!
//! **Every failure here is non-fatal.** A denied microphone, an
//! endpoint unplugged mid-session, a device that refuses shared mode —
//! none of them may end a recording. The screen content is what the
//! user came for, and a video with no audio track beats no video at
//! all. Constructors return `Ok(None)`-shaped outcomes or log and
//! degrade, and the session records whether audio *actually* happened
//! so the finished toast can say "recorded without audio" instead of
//! letting the user discover it on playback.
//!
//! **Polling, not event-driven.** `SetEventHandle` is the usual advice,
//! but a loopback client fires no events while nothing is playing —
//! a session recording a silent desktop would simply block forever.
//! Polling on a fixed cadence and synthesising silence for the gaps
//! keeps the audio timeline aligned with the video's regardless of
//! whether anything is making noise.

use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, EDataFlow, IAudioCaptureClient, IAudioClient, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE_ACTIVE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL, STGM_READ};

use clippity_infra::error::{AppError, AppResult};

use super::pcm::{self, SampleFormat, StereoResampler};

/// `WAVEFORMATEX::wFormatTag` values this module distinguishes.
///
/// Declared here rather than pulled from `Win32_Media_Multimedia`:
/// three integers do not justify another crate feature, and naming them
/// locally keeps the format-sniffing readable.
const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

/// How long an endpoint's shared-mode buffer should hold. Long enough
/// that a scheduling hiccup on the polling thread doesn't overrun it
/// (which shows up as a dropout), short enough not to add noticeable
/// latency to the A/V alignment.
const BUFFER_DURATION_HNS: i64 = 2_000_000; // 200 ms

/// Gap between polls of an endpoint. Comfortably inside
/// [`BUFFER_DURATION_HNS`] so a missed wake-up can't lose audio.
pub const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Which side of the audio graph a device sits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// A microphone or line-in — captured directly.
    Microphone,
    /// A speaker/headphone endpoint — captured in loopback, giving
    /// whatever the machine is playing.
    SystemLoopback,
}

impl Direction {
    fn data_flow(self) -> EDataFlow {
        match self {
            // Loopback captures *from* a render endpoint, so system
            // audio enumerates and opens on the render side.
            Direction::Microphone => eCapture,
            Direction::SystemLoopback => eRender,
        }
    }

    fn stream_flags(self) -> u32 {
        match self {
            Direction::Microphone => 0,
            Direction::SystemLoopback => AUDCLNT_STREAMFLAGS_LOOPBACK,
        }
    }
}

/// An audio endpoint offered to the settings UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioDevice {
    /// Opaque endpoint id — what `AudioSelection`'s device fields pin.
    pub id: String,
    /// Human-readable name, e.g. "Microphone (Yeti X)".
    pub name: String,
    /// Whether Windows currently considers this the default endpoint
    /// for its direction, so the UI can mark it.
    pub is_default: bool,
}

/// List active endpoints on one side of the graph.
///
/// Returns an empty list rather than an error when the machine has no
/// devices of that kind — a laptop with no microphone is a normal
/// configuration, not a failure the UI should shout about.
pub fn list_devices(direction: Direction) -> AppResult<Vec<AudioDevice>> {
    // SAFETY: standard COM activation of the endpoint enumerator; the
    // caller is on an initialised apartment (see `ComThread`).
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| AppError::Recorder(format!("audio device enumerator: {e}")))?;

    let flow = direction.data_flow();
    // A machine with no default endpoint is fine; it just means nothing
    // gets flagged as default.
    // SAFETY: valid enumerator, documented flow/role pair.
    let default_id = unsafe { enumerator.GetDefaultAudioEndpoint(flow, eConsole) }
        .ok()
        .and_then(|d| device_id(&d));

    // SAFETY: valid enumerator; ACTIVE excludes unplugged/disabled ones.
    let collection = unsafe { enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) }
        .map_err(|e| AppError::Recorder(format!("audio endpoint enumeration: {e}")))?;
    // SAFETY: valid collection.
    let count = unsafe { collection.GetCount() }.unwrap_or(0);

    let mut devices = Vec::with_capacity(count as usize);
    for i in 0..count {
        // SAFETY: index is bounded by GetCount.
        let Ok(device) = (unsafe { collection.Item(i) }) else {
            continue;
        };
        let Some(id) = device_id(&device) else {
            continue;
        };
        // An endpoint whose friendly name can't be read still works;
        // fall back to its id rather than dropping it from the list.
        let name = device_name(&device).unwrap_or_else(|| id.clone());
        let is_default = default_id.as_deref() == Some(id.as_str());
        devices.push(AudioDevice {
            id,
            name,
            is_default,
        });
    }
    Ok(devices)
}

/// Read an endpoint's id, freeing the string COM allocated for it.
fn device_id(device: &IMMDevice) -> Option<String> {
    // SAFETY: GetId returns a COM-allocated NUL-terminated wide string
    // the caller owns; it is read and then freed exactly once.
    unsafe {
        let raw = device.GetId().ok()?;
        if raw.is_null() {
            return None;
        }
        let value = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0 as *const _));
        value
    }
}

/// Read an endpoint's friendly name from its property store.
fn device_name(device: &IMMDevice) -> Option<String> {
    // SAFETY: read-only property store; PROPVARIANT is dropped by its
    // Rust wrapper, which calls PropVariantClear.
    unsafe {
        let store = device.OpenPropertyStore(STGM_READ).ok()?;
        let value = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let name = value.to_string();
        (!name.is_empty()).then_some(name)
    }
}

/// One open, running WASAPI stream normalised to the encoder's format.
///
/// `!Send` like every COM object here — created and drained on the
/// audio thread that owns it.
pub struct AudioCapture {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    format: SampleFormat,
    channels: u16,
    resampler: StereoResampler,
    direction: Direction,
    /// Set once the endpoint has delivered at least one non-silent
    /// packet. Distinguishes "recorded audio" from "opened a device
    /// that never produced anything", which is what the finished toast
    /// needs to be honest about.
    heard_anything: bool,
}

impl AudioCapture {
    /// Open and start an endpoint.
    ///
    /// `device_id` pins a specific endpoint; `None` follows the OS
    /// default. Errors are returned rather than logged so the caller can
    /// decide — the recorder logs and continues without this track.
    pub fn open(
        direction: Direction,
        device_id: Option<&str>,
        target_rate: u32,
    ) -> AppResult<Self> {
        // SAFETY: standard COM activation; caller is on an initialised
        // apartment.
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|e| AppError::Recorder(format!("audio device enumerator: {e}")))?;

        let device = match device_id {
            Some(id) => {
                let mut wide: Vec<u16> = id.encode_utf16().collect();
                wide.push(0);
                // SAFETY: NUL-terminated wide id that outlives the call.
                unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())) }.map_err(|e| {
                    AppError::Recorder(format!("audio device {id} is unavailable: {e}"))
                })?
            }
            // SAFETY: documented flow/role pair.
            None => unsafe { enumerator.GetDefaultAudioEndpoint(direction.data_flow(), eConsole) }
                .map_err(|e| AppError::Recorder(format!("no default audio device: {e}")))?,
        };

        // SAFETY: activating the audio client on a live endpoint with no
        // activation parameters.
        let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
            .map_err(|e| AppError::Recorder(format!("audio device busy: {e}")))?;

        // SAFETY: returns a COM-allocated WAVEFORMATEX describing the
        // endpoint's shared-mode mix format; freed below after use.
        let mix = unsafe { client.GetMixFormat() }
            .map_err(|e| AppError::Recorder(format!("audio mix format: {e}")))?;
        if mix.is_null() {
            return Err(AppError::Recorder("audio device reported no format".into()));
        }

        // Describe, then initialise, then free — in that order. The
        // format pointer has to stay alive across `Initialize`, which
        // reads it; freeing it first would hand the driver a dangling
        // pointer. Both fallible steps therefore run inside one block
        // whose result is unpacked only after the free.
        //
        // Shared mode initialises against the endpoint's *own* mix
        // format and we convert on our side (`super::pcm`). Asking the
        // device for 48 kHz stereo instead would fail outright on any
        // endpoint whose driver doesn't offer exactly that.
        //
        // SAFETY: `mix` is a valid non-null WAVEFORMATEX from
        // GetMixFormat, live for the whole block; the extensible read
        // inside `describe_format` is gated on `cbSize`. It is freed
        // exactly once, on every path out.
        let opened = (|| -> AppResult<(SampleFormat, u16, u32)> {
            // SAFETY: `mix` is valid and non-null here.
            let shape = unsafe { describe_format(mix) }?;
            // SAFETY: `mix` is still live — the free happens below,
            // after this returns.
            unsafe {
                client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    direction.stream_flags(),
                    BUFFER_DURATION_HNS,
                    0,
                    mix,
                    None,
                )
            }
            .map_err(|e| AppError::Recorder(format!("audio device would not open: {e}")))?;
            Ok(shape)
        })();
        // SAFETY: frees the COM allocation from GetMixFormat exactly
        // once, on every path out of the block above.
        unsafe { CoTaskMemFree(Some(mix as *const _)) };
        let (format, channels, rate) = opened?;

        // SAFETY: the client is initialised, so the capture service is
        // available.
        let capture: IAudioCaptureClient = unsafe { client.GetService() }
            .map_err(|e| AppError::Recorder(format!("audio capture service: {e}")))?;

        // SAFETY: an initialised client.
        unsafe { client.Start() }
            .map_err(|e| AppError::Recorder(format!("audio capture would not start: {e}")))?;

        Ok(Self {
            client,
            capture,
            format,
            channels,
            resampler: StereoResampler::new(rate, target_rate),
            direction,
            heard_anything: false,
        })
    }

    /// Which source this stream is, for logging and for the HUD's
    /// per-source level meters.
    pub fn direction(&self) -> Direction {
        self.direction
    }

    /// Whether this endpoint has produced any non-silent audio.
    pub fn heard_anything(&self) -> bool {
        self.heard_anything
    }

    /// Drain every packet currently queued, returning interleaved
    /// stereo f32 at the target rate.
    ///
    /// Returns an empty vec when the endpoint has nothing queued — the
    /// normal state for loopback on a quiet desktop. The caller pads
    /// with [`pcm::silence`] rather than treating it as an error.
    pub fn drain(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        loop {
            // SAFETY: valid capture client; a zero return means nothing
            // is queued.
            let available = match unsafe { self.capture.GetNextPacketSize() } {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if available == 0 {
                break;
            }

            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames: u32 = 0;
            let mut flags: u32 = 0;
            // SAFETY: out-pointers to locals; on success `data` points
            // at `frames` frames of the endpoint's mix format, valid
            // until the matching ReleaseBuffer below.
            if unsafe {
                self.capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
            }
            .is_err()
            {
                break;
            }

            if frames > 0 && !data.is_null() {
                let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                let decoded = if silent {
                    // The endpoint says "this packet is silence" and the
                    // buffer contents are undefined — synthesise rather
                    // than decode whatever happens to be in memory.
                    vec![0.0f32; frames as usize * 2]
                } else {
                    let len = frames as usize * self.format.bytes() * self.channels.max(1) as usize;
                    // SAFETY: the endpoint guarantees `frames` frames of
                    // its declared format at `data`; the slice does not
                    // outlive the ReleaseBuffer below.
                    let raw = unsafe { std::slice::from_raw_parts(data, len) };
                    let decoded = pcm::decode_to_stereo(raw, self.format, self.channels);
                    if !self.heard_anything && decoded.iter().any(|s| s.abs() > 0.0001) {
                        self.heard_anything = true;
                    }
                    decoded
                };
                out.extend_from_slice(&self.resampler.process(&decoded));
            }

            // SAFETY: releases exactly the frames GetBuffer reported.
            let _ = unsafe { self.capture.ReleaseBuffer(frames) };
        }
        out
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        // SAFETY: stopping a started client; errors are meaningless on
        // teardown.
        let _ = unsafe { self.client.Stop() };
    }
}

/// Read a `WAVEFORMATEX` (possibly a `WAVEFORMATEXTENSIBLE`) into the
/// shape `pcm` needs.
///
/// # Safety
/// `format` must be a valid, non-null `WAVEFORMATEX` whose `cbSize`
/// honestly describes any trailing extensible block.
unsafe fn describe_format(format: *const WAVEFORMATEX) -> AppResult<(SampleFormat, u16, u32)> {
    let base = unsafe { &*format };
    let channels = base.nChannels;
    let rate = base.nSamplesPerSec;
    let bits = base.wBitsPerSample;

    let tag = if base.wFormatTag == WAVE_FORMAT_EXTENSIBLE {
        if (base.cbSize as usize) < 22 {
            return Err(AppError::Recorder(
                "audio device reported a malformed extensible format".into(),
            ));
        }
        // Every KSDATAFORMAT_SUBTYPE_* GUID is
        // {tag}-0000-0010-8000-00AA00389B71, so the low word of Data1
        // *is* the wave format tag. Reading it that way avoids a
        // dependency on the individual subtype constants.
        let ext = unsafe { &*(format as *const WAVEFORMATEXTENSIBLE) };
        ext.SubFormat.data1 as u16
    } else {
        base.wFormatTag
    };

    let sample = match (tag, bits) {
        (WAVE_FORMAT_IEEE_FLOAT, _) => SampleFormat::F32,
        (WAVE_FORMAT_PCM, 16) => SampleFormat::I16,
        (WAVE_FORMAT_PCM, 24) => SampleFormat::I24,
        (WAVE_FORMAT_PCM, 32) => SampleFormat::I32,
        _ => {
            return Err(AppError::Recorder(format!(
                "unsupported audio format (tag {tag}, {bits}-bit)"
            )))
        }
    };
    Ok((sample, channels, rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_captures_from_the_render_side() {
        // The single most confusing thing about WASAPI loopback: system
        // audio is captured from a *render* endpoint, not a capture one.
        // Getting this backwards silently records the microphone as
        // "system audio".
        assert_eq!(Direction::SystemLoopback.data_flow(), eRender);
        assert_eq!(Direction::Microphone.data_flow(), eCapture);
    }

    #[test]
    fn only_loopback_sets_the_loopback_flag() {
        assert_eq!(
            Direction::SystemLoopback.stream_flags(),
            AUDCLNT_STREAMFLAGS_LOOPBACK
        );
        assert_eq!(Direction::Microphone.stream_flags(), 0);
    }

    #[test]
    fn polling_stays_well_inside_the_endpoint_buffer() {
        // A poll interval at or beyond the buffer duration would let the
        // endpoint overrun between wake-ups, which is heard as dropouts.
        let buffer_ms = (BUFFER_DURATION_HNS / 10_000) as u128;
        assert!(
            POLL_INTERVAL.as_millis() * 4 < buffer_ms,
            "poll {}ms vs buffer {}ms",
            POLL_INTERVAL.as_millis(),
            buffer_ms
        );
    }

    /// Enumerates real endpoints. `#[ignore]`d for the same reason the
    /// encoder test is: it needs a machine with a sound stack.
    #[test]
    #[ignore = "needs a Windows session with audio endpoints"]
    fn lists_real_endpoints() {
        let _com = super::super::media_foundation::ComThread::init().expect("COM");
        let render = list_devices(Direction::SystemLoopback).expect("render endpoints");
        assert!(
            !render.is_empty(),
            "a desktop should expose at least one render endpoint"
        );
        for d in &render {
            assert!(!d.id.is_empty());
            assert!(!d.name.is_empty());
        }
        assert!(
            render.iter().filter(|d| d.is_default).count() <= 1,
            "at most one default endpoint"
        );
        // Capture endpoints are allowed to be absent (no microphone).
        let _ = list_devices(Direction::Microphone).expect("capture enumeration succeeds");
    }

    /// Opens a real loopback stream and drains it.
    ///
    /// This is the test that matters for the unsafe path: `Initialize`
    /// with the loopback flag, `GetService`, `Start`, and the
    /// `GetBuffer`/`ReleaseBuffer` pairing. A mismatched
    /// release-after-get corrupts the endpoint's ring buffer, which
    /// shows up as garbled audio much later — not as a compile error.
    ///
    /// Deliberately does **not** assert that samples arrive: a quiet
    /// desktop legitimately produces none, and asserting otherwise
    /// would make this fail for the wrong reason.
    #[test]
    #[ignore = "needs a Windows session with audio endpoints"]
    fn opens_and_drains_a_real_loopback_stream() {
        use super::super::media_foundation::AUDIO_SAMPLE_RATE;

        let _com = super::super::media_foundation::ComThread::init().expect("COM");
        let mut capture = AudioCapture::open(Direction::SystemLoopback, None, AUDIO_SAMPLE_RATE)
            .expect("default render endpoint opens in loopback mode");
        assert_eq!(capture.direction(), Direction::SystemLoopback);

        let mut samples = 0usize;
        for _ in 0..30 {
            samples += capture.drain().len();
            std::thread::sleep(POLL_INTERVAL);
        }
        // Stereo interleaving means an even count, always.
        assert_eq!(samples % 2, 0, "stereo output must stay frame-aligned");
        println!("loopback drained {samples} samples in ~300ms (0 is valid when silent)");
    }
}
