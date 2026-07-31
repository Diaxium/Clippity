//! Screen-recording domain types — the pure shape of a recording
//! request, the live session status the HUD renders, and the timing /
//! sizing math both output encoders depend on.
//!
//! **Named `recorder`, not `recording`.** `domain::scroll` already owns
//! a thing called a "recording": the Scrolling-Window / Panoramic
//! stitcher, whose worker emits `clippity://recording/*` and whose HUD
//! is `RecordingToastBody`. That session produces a *still image* from
//! many frames. This module produces a *video* (or GIF) from many
//! frames. They share a silhouette — start, tick, stop-or-discard — and
//! nothing else, so they get separate names, separate events
//! (`clippity://recorder/*`) and separate services rather than one
//! overloaded pipeline.
//!
//! One session, two outputs: a recording is captured once and encoded
//! as either MP4/H.264 (via Media Foundation) or GIF, chosen up front
//! by [`RecorderFormat`]. Everything that differs between the two —
//! frame-rate range, duration ceiling, whether audio means anything —
//! is answered here so neither encoder has to re-derive it.
//!
//! No I/O, no Tauri, no platform code.

use serde::{Deserialize, Serialize};

use crate::overlay::Region;

// ---- Frame-rate ranges ----
//
// Each format gets its own range because they fail differently at the
// edges. H.264 is happy anywhere in the usual video range; GIF pays for
// every frame twice (a full frame buffered in memory for the global
// palette pass, then a full LZW-compressed frame on disk), so its
// ceiling is set by file size and RAM rather than by the codec.

/// Frame-rate bounds for an MP4 recording. The floor is where motion
/// stops reading as motion; the ceiling is where a software-fallback
/// encoder on a 4K desktop starts dropping frames faster than it
/// encodes them.
pub const MP4_FPS_MIN: u32 = 10;
pub const MP4_FPS_MAX: u32 = 60;
pub const MP4_FPS_DEFAULT: u32 = 30;

/// Frame-rate bounds for a GIF. The ceiling is deliberately low: GIF
/// stores a delay per frame in **centiseconds**, so above 50 fps the
/// delay rounds to zero and viewers substitute their own (usually
/// 10 cs) — the animation would play at a speed nobody asked for. It
/// is also the single biggest lever on output size.
pub const GIF_FPS_MIN: u32 = 5;
pub const GIF_FPS_MAX: u32 = 30;
pub const GIF_FPS_DEFAULT: u32 = 15;

// ---- Duration ceilings ----

/// Hard ceiling on an MP4 session. Not a product limit so much as a
/// backstop: a recording the user forgot about must not fill the disk.
/// The service stops (and keeps) the recording at this point rather
/// than discarding it.
pub const MP4_MAX_DURATION_MS: u64 = 3 * 60 * 60 * 1_000;

/// Hard ceiling on a GIF session — two orders of magnitude shorter than
/// MP4's, and for a different reason. GIF quantization needs the frames
/// in memory to build one global palette, so the session's peak RSS
/// grows linearly with duration. A minute at [`GIF_FPS_DEFAULT`] and
/// [`GIF_MAX_EDGE`] is a few hundred MB of RGBA — already generous for
/// the format's actual use (a short loop), and the point past which
/// users would be better served by MP4.
pub const GIF_MAX_DURATION_MS: u64 = 60 * 1_000;

/// Pixel budget a GIF is downscaled into before quantization. GIF is a
/// 256-colour format; at full 4K it produces enormous files that no
/// chat client will accept and that dithering can't rescue anyway.
/// Recordings already inside the budget are left alone.
///
/// **An area budget, not an edge cap**, because an edge cap punishes
/// wide aspect ratios in proportion to how wide they are. A 32:9
/// ultrawide clip under an 800 px longest-edge rule lands at 800×225 —
/// the same pixel count as a postage stamp, spread so thin that text is
/// gone. Budgeting area instead gives that clip 1132×318 for the same
/// bytes. 360 000 is exactly what the old 800 px edge cap produced for
/// a 16:9 recording, so the common case is unchanged by construction.
pub const GIF_MAX_PIXELS: u32 = 800 * 450;

/// Secondary bound on a GIF's longest edge, applied after
/// [`GIF_MAX_PIXELS`]. The area budget alone would let a pathologically
/// thin strip (a 4000×50 toolbar recording) through at full width; this
/// keeps any single dimension inside what a chat client will inline.
/// Chosen to be non-binding for every ordinary aspect ratio, so it is a
/// backstop rather than a second cap.
pub const GIF_MAX_EDGE: u32 = 1280;

/// Smallest recordable edge, in physical pixels. H.264 macroblocks are
/// 16×16 and Media Foundation rejects degenerate frame sizes outright;
/// this is also below any region a user would deliberately record.
pub const MIN_RECORD_PX: u32 = 32;

/// Media Foundation's time unit: 100-nanosecond ticks. Every timestamp
/// and duration handed to the sink writer is in these, so the
/// conversion helpers below produce them directly rather than making
/// each call site remember the factor.
pub const HNS_PER_SECOND: i64 = 10_000_000;

/// Bits per pixel per frame targeted by [`video_bitrate_bps`]. Tuned
/// for screen content, which is mostly static between frames and
/// compresses far better than camera footage — the usual 0.1 bpp
/// camera heuristic overshoots badly for a desktop recording.
const BITS_PER_PIXEL: f64 = 0.07;

/// Bitrate floor / ceiling. The floor keeps a small region legible
/// (text on a 400×300 crop still needs real bits); the ceiling stops a
/// 4K60 session from asking for a bitrate no disk wants.
///
/// The ceiling is 60 rather than 40 Mbps because 40 was low enough to
/// bind on displays people actually own: a 5120×2160 ultrawide at 60 fps
/// computes to ~46 Mbps, so the clamp — meant as a runaway guard —
/// was silently degrading the format it was sized for. 60 clears every
/// current desktop panel at 60 fps while still refusing the genuinely
/// absurd.
const BITRATE_MIN_BPS: u32 = 1_500_000;
const BITRATE_MAX_BPS: u32 = 60_000_000;

/// What surface the session records. The rectangle itself is resolved
/// by the service (a window moves; a monitor is enumerated), so this
/// carries only the user's *intent* — which is what a preset should
/// store and what the HUD should label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecorderTarget {
    Region,
    Window,
    Fullscreen,
}

/// Output format, chosen before the session starts.
///
/// This is the *only* thing that forks the pipeline: capture, cropping,
/// pacing, the HUD and the save path are identical either way, and the
/// frames land in a different encoder at the end. Choosing up front
/// (rather than encoding MP4 always and converting later) means the GIF
/// path never has to decode H.264 back out, and lets the session apply
/// GIF's lower frame-rate and duration ceilings while recording instead
/// of discovering them at export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecorderFormat {
    Mp4,
    Gif,
}

impl RecorderFormat {
    /// File extension for this format — the one place the mapping
    /// lives, so the save path and the library's extension-based
    /// [`crate::library::kind_of`] classification can't drift apart.
    pub fn extension(self) -> &'static str {
        match self {
            RecorderFormat::Mp4 => "mp4",
            RecorderFormat::Gif => "gif",
        }
    }

    /// Whether this format can carry an audio track at all. GIF cannot,
    /// which is why [`AudioSelection`] is silently emptied for it during
    /// validation rather than rejected — a user switching format
    /// shouldn't have their recording refused over a toggle the new
    /// format simply ignores.
    pub fn supports_audio(self) -> bool {
        matches!(self, RecorderFormat::Mp4)
    }

    /// Inclusive frame-rate range this format accepts.
    pub fn fps_range(self) -> (u32, u32) {
        match self {
            RecorderFormat::Mp4 => (MP4_FPS_MIN, MP4_FPS_MAX),
            RecorderFormat::Gif => (GIF_FPS_MIN, GIF_FPS_MAX),
        }
    }

    /// Frame rate used when the request doesn't specify one.
    pub fn default_fps(self) -> u32 {
        match self {
            RecorderFormat::Mp4 => MP4_FPS_DEFAULT,
            RecorderFormat::Gif => GIF_FPS_DEFAULT,
        }
    }

    /// Longest session this format allows before the service commits
    /// what it has. See [`MP4_MAX_DURATION_MS`] / [`GIF_MAX_DURATION_MS`].
    pub fn max_duration_ms(self) -> u64 {
        match self {
            RecorderFormat::Mp4 => MP4_MAX_DURATION_MS,
            RecorderFormat::Gif => GIF_MAX_DURATION_MS,
        }
    }
}

/// Which audio inputs to mix into the recording.
///
/// Two independent booleans rather than one enum because both can be on
/// at once — narrating over system sound is the common case for a demo
/// recording — and each fails independently (a missing mic must not
/// cost the user their system audio). The optional device ids pin a
/// specific endpoint; `None` follows the OS default, including when the
/// user changes it mid-session.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSelection {
    /// Capture the microphone (a WASAPI capture endpoint).
    #[serde(default)]
    pub microphone: bool,
    /// Capture what the machine is playing (a WASAPI render endpoint
    /// opened in loopback mode).
    #[serde(default)]
    pub system: bool,
    /// Pin the microphone to this endpoint id. `None` = OS default.
    #[serde(default)]
    pub microphone_device: Option<String>,
    /// Pin system audio to this render endpoint id. `None` = OS default.
    #[serde(default)]
    pub system_device: Option<String>,
}

impl AudioSelection {
    /// Whether any audio at all was asked for — the sink writer only
    /// declares an audio stream when this is true, and a muxed file with
    /// an empty audio track is worse than one with no track.
    pub fn any(&self) -> bool {
        self.microphone || self.system
    }
}

/// Recording-specific toggles. Deliberately *not* [`crate::capture::CaptureToggles`]:
/// smart-enhance has no meaning for a frame stream, `clipboard` means
/// something different here (see below), and this adds one stills don't
/// have.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderToggles {
    /// Composite the cursor into each frame. Off by default for the
    /// same reason it is for stills: the pointer is usually incidental.
    #[serde(default)]
    pub cursor: bool,
    /// Draw a click highlight when a mouse button goes down. Implies
    /// `cursor` — a click ring with no pointer under it reads as a
    /// rendering bug, so validation turns `cursor` on rather than
    /// rejecting the combination.
    #[serde(default)]
    pub clicks: bool,
    /// Open the finished recording once it is saved (the recorder's
    /// equivalent of "Preview in Editor"; the editor can't annotate
    /// video, so this hands off to the library inspector).
    #[serde(default)]
    pub preview: bool,
    /// Put the finished clip on the system clipboard, so it can be
    /// pasted straight into a chat, an email, or a folder.
    ///
    /// Copies the file **by reference** (`CF_HDROP`), not by value —
    /// which is what makes this viable for a video at all, and what
    /// separates it from the stills toggle of the same name, where the
    /// pixels themselves go on the clipboard. The cost is constant in
    /// the recording's length, and the paste lands as an attachment in
    /// every app that accepts a dragged file.
    ///
    /// The trade-off is the one Explorer's own Copy has: the clipboard
    /// names a path, so moving or deleting the clip before pasting
    /// breaks it. Worth it — the alternative is no clipboard support
    /// for recordings at all, since no app reads a raw MP4 blob.
    #[serde(default)]
    pub clipboard: bool,
}

/// What the frontend sends to start a session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderRequest {
    pub target: RecorderTarget,
    /// The rectangle to record, in physical pixels on the virtual
    /// desktop — the same space as [`Region`] everywhere else. Required
    /// for [`RecorderTarget::Region`] and [`RecorderTarget::Window`];
    /// for [`RecorderTarget::Fullscreen`] it is `None` and the service
    /// resolves the monitor.
    #[serde(default)]
    pub region: Option<Region>,
    /// Source window's HWND bits, for `Window` targets. Carried so the
    /// service can follow the window if it moves, and so the saved
    /// file's provenance can name the app.
    #[serde(default)]
    pub window_id: Option<u64>,
    pub format: RecorderFormat,
    /// Requested frame rate. `None` = the format's default; out-of-range
    /// values are clamped rather than rejected (see [`clamp_fps`]).
    #[serde(default)]
    pub fps: Option<u32>,
    #[serde(default)]
    pub audio: AudioSelection,
    #[serde(default)]
    pub toggles: RecorderToggles,
    /// Save-directory override, exactly as [`crate::capture::CaptureRequest::output_dir`]
    /// (ADR 0004). `None` / empty = the live captures dir.
    #[serde(default)]
    pub output_dir: Option<String>,
    /// Name of the preset that started this recording, for the
    /// provenance sidecar. `None` = started interactively.
    #[serde(default)]
    pub preset: Option<String>,
}

/// A [`RecorderRequest`] that has been through [`validate`]: the region
/// is resolved and clamped, the frame rate is in range, and the audio
/// selection is consistent with the format. The service takes this, not
/// the raw request, so no encoder has to re-check any of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedRecorderRequest {
    pub target: RecorderTarget,
    pub region: Region,
    pub window_id: Option<u64>,
    pub format: RecorderFormat,
    pub fps: u32,
    pub audio: AudioSelection,
    pub toggles: RecorderToggles,
    pub output_dir: Option<String>,
    pub preset: Option<String>,
}

/// Where a live session is. Drives the HUD's controls (a paused session
/// shows Resume, not Pause) and gates the commands — `pause` on an idle
/// session is a caller bug, not a no-op.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecorderState {
    Idle,
    Recording,
    Paused,
}

/// Live session status, emitted on `clippity://recorder/tick` roughly
/// once a second and returned by the start/pause/resume commands so the
/// HUD can render before the first tick arrives.
///
/// `elapsed_ms` is **recorded** time, not wall-clock since start: a
/// paused session's timer must not keep climbing, because the number the
/// HUD shows is a promise about the length of the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderStatus {
    pub state: RecorderState,
    pub elapsed_ms: u64,
    pub frames: u64,
    /// Frames the capture source produced that the encoder couldn't keep
    /// up with. Surfaced (not just logged) because a climbing count is
    /// the one signal that tells a user to lower the frame rate.
    pub dropped: u64,
    /// Bytes committed to the on-disk file so far. Zero for GIF until
    /// the encode runs — GIF has nothing on disk until quantization, and
    /// claiming otherwise would make the HUD lie.
    pub bytes: u64,
}

impl RecorderStatus {
    /// The status of a session that hasn't started.
    pub fn idle() -> Self {
        Self {
            state: RecorderState::Idle,
            elapsed_ms: 0,
            frames: 0,
            dropped: 0,
            bytes: 0,
        }
    }
}

/// What the backend returns on a committed stop, and what
/// `clippity://recorder/finished` carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderResult {
    pub id: String,
    pub target: RecorderTarget,
    pub format: RecorderFormat,
    pub width: u32,
    pub height: u32,
    /// Absolute path to the saved recording.
    pub path: String,
    pub duration_ms: u64,
    pub frames: u64,
    /// Whether an audio track was actually written — not merely
    /// requested. A denied microphone yields `false`, and the toast says
    /// so, rather than the user discovering the silence on playback.
    pub has_audio: bool,
    /// Mirrors [`RecorderToggles::preview`] onto the finished event, the
    /// same way [`crate::capture::CaptureResult::preview`] does, so a
    /// single persistent listener can open the result regardless of which
    /// window started the session.
    pub preview: bool,
}

/// Why a session ended. The HUD renders all three differently, and only
/// `Committed` produces a [`RecorderResult`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecorderStopReason {
    /// The user pressed Stop.
    Committed,
    /// The user pressed Discard — the partial file is deleted.
    Discarded,
    /// The session hit [`RecorderFormat::max_duration_ms`]. Committed,
    /// not discarded: an over-long recording is still the user's
    /// recording.
    DurationLimit,
    /// Capture or encoding failed partway. Whatever was written is kept
    /// and the payload explains why, because a truncated recording of a
    /// thing that already happened cannot be re-taken.
    Failed,
}

impl RecorderStopReason {
    /// Whether this outcome keeps the file. Only [`Self::Discarded`]
    /// throws work away; a failure keeps the partial file precisely
    /// because the moment it recorded is gone.
    pub fn keeps_output(self) -> bool {
        !matches!(self, RecorderStopReason::Discarded)
    }
}

/// Clamp a requested frame rate into the format's range, falling back
/// to its default when unspecified.
///
/// Clamps rather than rejects: frame rate arrives from settings, from
/// presets saved under an older build, and from a format switch that
/// leaves a 60 in a GIF-bound field. None of those are worth refusing a
/// recording over, and every one has an obviously-correct nearest legal
/// value.
pub fn clamp_fps(requested: Option<u32>, format: RecorderFormat) -> u32 {
    let (min, max) = format.fps_range();
    match requested {
        None | Some(0) => format.default_fps(),
        Some(fps) => fps.clamp(min, max),
    }
}

/// Round a rectangle down to even width and height, keeping its origin.
///
/// H.264's 4:2:0 chroma planes are half-resolution in both axes, so an
/// odd dimension has no representation — Media Foundation either rejects
/// the media type or silently pads, which shifts every subsequent row
/// and produces the classic diagonal-smear frame. Rounding *down* (and
/// losing at most one pixel row/column) is invisible; padding up would
/// invent content at the edge.
///
/// Applied to GIF too, so a session's dimensions don't depend on the
/// format that consumes it.
pub fn even_dimensions(width: u32, height: u32) -> (u32, u32) {
    (width & !1, height & !1)
}

/// Validate and normalise a recording request.
///
/// `virtual_w` / `virtual_h` bound the region the same way
/// [`crate::overlay::validate_region`] does; `fullscreen` supplies the
/// rectangle for a [`RecorderTarget::Fullscreen`] session, which the
/// caller resolves from the monitor the cursor is on.
///
/// Normalisations applied here rather than in the service, so both
/// encoders and the HUD see one already-consistent shape:
/// - frame rate clamped into the format's range ([`clamp_fps`]);
/// - dimensions rounded to even ([`even_dimensions`]);
/// - `clicks` implies `cursor`;
/// - audio emptied for a format that can't carry it.
pub fn validate(
    request: RecorderRequest,
    virtual_w: u32,
    virtual_h: u32,
    fullscreen: Option<Region>,
) -> Result<ValidatedRecorderRequest, &'static str> {
    if virtual_w == 0 || virtual_h == 0 {
        return Err("virtual desktop has zero area");
    }

    let requested = match request.target {
        RecorderTarget::Fullscreen => fullscreen.ok_or("no monitor to record")?,
        RecorderTarget::Region | RecorderTarget::Window => {
            request.region.ok_or("no region to record")?
        }
    };

    let region = clamp_region(requested, virtual_w, virtual_h)?;
    let (width, height) = even_dimensions(region.width, region.height);
    if width < MIN_RECORD_PX || height < MIN_RECORD_PX {
        return Err("recording area smaller than minimum");
    }

    let mut toggles = request.toggles;
    if toggles.clicks {
        toggles.cursor = true;
    }

    let audio = if request.format.supports_audio() {
        request.audio
    } else {
        AudioSelection::default()
    };

    Ok(ValidatedRecorderRequest {
        target: request.target,
        region: Region {
            x: region.x,
            y: region.y,
            width,
            height,
        },
        window_id: request.window_id,
        format: request.format,
        fps: clamp_fps(request.fps, request.format),
        audio,
        toggles,
        output_dir: request.output_dir,
        preset: request.preset,
    })
}

/// Clip a rectangle to the virtual desktop. Same shape as
/// [`crate::overlay::validate_region`] but with the recorder's own
/// minimum — a 32 px floor is meaningful for a video where an 8 px one
/// is meaningful for a still.
fn clamp_region(region: Region, virtual_w: u32, virtual_h: u32) -> Result<Region, &'static str> {
    let x = region.x.min(virtual_w.saturating_sub(1));
    let y = region.y.min(virtual_h.saturating_sub(1));
    let width = region.width.min(virtual_w.saturating_sub(x));
    let height = region.height.min(virtual_h.saturating_sub(y));
    if width == 0 || height == 0 {
        return Err("recording area has zero extent");
    }
    Ok(Region {
        x,
        y,
        width,
        height,
    })
}

/// Nominal gap between frames, in milliseconds — what the capture
/// worker paces itself against.
pub fn frame_interval_ms(fps: u32) -> u64 {
    let fps = fps.max(1) as u64;
    // Round to nearest so 30 fps is 33 ms rather than 33.33 truncated to
    // 33 in one place and 34 in another.
    (1_000 + fps / 2) / fps
}

/// A timestamp in milliseconds expressed in Media Foundation's 100 ns
/// ticks.
///
/// Presentation timestamps come from the *wall clock* (minus paused
/// time), not from `frame_index × frame_duration`. Screen capture is
/// inherently variable-rate — a frame the compositor never produced
/// (nothing on screen changed) or one the encoder had to drop must not
/// shift every later frame earlier, which is exactly what an index-derived
/// timeline does. Deriving from elapsed time instead keeps the video's
/// clock locked to the audio's, which has its own hardware-driven one.
pub fn hns_from_millis(ms: u64) -> i64 {
    (ms as i64).saturating_mul(HNS_PER_SECOND / 1_000)
}

/// Nominal frame duration in 100 ns ticks, for the sink writer's
/// declared frame rate.
pub fn frame_duration_hns(fps: u32) -> i64 {
    HNS_PER_SECOND / fps.max(1) as i64
}

/// Per-frame delay for a GIF, in centiseconds — the only time unit the
/// format has.
///
/// Clamped to a floor of 2 cs because a 0 or 1 cs delay is the one case
/// browsers and image viewers actively override: historically both meant
/// "as fast as possible", so viewers substitute 10 cs, and an animation
/// asking for 100 fps plays back at 10. Two is the smallest delay that
/// is honoured, and [`GIF_FPS_MAX`] keeps requests off the clamp anyway.
pub fn gif_frame_delay_cs(fps: u32) -> u16 {
    let fps = fps.max(1) as u64;
    let cs = (100 + fps / 2) / fps;
    cs.clamp(2, u16::MAX as u64) as u16
}

/// Target H.264 bitrate for a frame size and rate, in bits per second.
///
/// A resolution-aware target rather than a fixed one: the same 8 Mbps
/// that is generous for a 720p region starves a 4K desktop, and Media
/// Foundation's encoder does not pick for you — an unset bitrate lands
/// on a conservative default that makes text mushy.
pub fn video_bitrate_bps(width: u32, height: u32, fps: u32) -> u32 {
    let pixels = width as f64 * height as f64;
    let raw = pixels * fps.max(1) as f64 * BITS_PER_PIXEL;
    (raw as u64).clamp(BITRATE_MIN_BPS as u64, BITRATE_MAX_BPS as u64) as u32
}

/// Downscale `(width, height)` into GIF's pixel budget, preserving the
/// aspect ratio. Returns the input unchanged when it already fits —
/// upscaling a small recording would only add weight.
///
/// Two bounds apply and the tighter one wins: [`GIF_MAX_PIXELS`] caps
/// the area (which is what the file size actually tracks), and
/// [`GIF_MAX_EDGE`] caps the longest side so a very thin strip can't
/// slip through at full width. Ordering them this way is the ultrawide
/// fix: an area budget shrinks a 32:9 clip by the same factor in both
/// axes rather than flattening it to a letterbox.
///
/// The result is forced even for the same reason [`even_dimensions`]
/// exists: a session's frames are cropped once, and both encoders read
/// the same buffers.
pub fn gif_target_size(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (width, height);
    }
    let pixels = width as f64 * height as f64;
    // Linear scale, so the *area* scales by the square of it.
    let by_area = (GIF_MAX_PIXELS as f64 / pixels).sqrt();
    let by_edge = GIF_MAX_EDGE as f64 / width.max(height) as f64;
    let scale = by_area.min(by_edge);
    if scale >= 1.0 {
        return (width, height);
    }
    let w = ((width as f64 * scale).round() as u32).max(2);
    let h = ((height as f64 * scale).round() as u32).max(2);
    even_dimensions(w, h)
}

/// Lowest H.264 level that can carry `(width, height)` at `fps` and
/// `bitrate_bps`, as the level-times-ten code Media Foundation's
/// `MF_MT_MPEG2_LEVEL` expects (51 = level 5.1).
///
/// **This exists because leaving the level unset is not safe at
/// ultrawide sizes.** Media Foundation infers a level from the frame
/// size when the caller doesn't state one, and several hardware
/// encoders infer one too small for a >4096-px-wide frame and then
/// refuse the media type outright — which surfaces as "no H.264 encoder
/// available" at the moment the user pressed Record. Stating the level
/// removes the guess.
///
/// Bounds come from the H.264 spec's Table A-1: `MaxFS` (frame size in
/// macroblocks), `MaxMBPS` (macroblocks per second), and `MaxBR` (bits
/// per second, at Main profile's VCL factor). The lowest level that
/// satisfies all three wins, floored at 4.2 — below that the levels
/// start capping bitrate tightly enough to hurt a small region, and
/// nothing that plays H.264 at all is short of 4.2 support.
///
/// Returns the top level (6.2) rather than failing for a frame larger
/// than the spec covers: refusing to record is worse than handing the
/// encoder a level it will reject on its own terms with a real message.
pub fn h264_level(width: u32, height: u32, fps: u32, bitrate_bps: u32) -> u32 {
    // Macroblocks are 16×16; a partial one still occupies a whole block.
    let mbs = width.div_ceil(16) as u64 * height.div_ceil(16) as u64;
    let mbps = mbs * fps.max(1) as u64;
    let br = bitrate_bps as u64;

    // (level code, MaxFS, MaxMBPS, MaxBR)
    const LEVELS: &[(u32, u64, u64, u64)] = &[
        (42, 8_704, 522_240, 20_000_000),
        (50, 22_080, 589_824, 135_000_000),
        (51, 36_864, 983_040, 240_000_000),
        (52, 36_864, 2_073_600, 240_000_000),
        (60, 139_264, 4_177_920, 240_000_000),
        (61, 139_264, 8_355_840, 480_000_000),
        (62, 139_264, 16_711_680, 800_000_000),
    ];

    LEVELS
        .iter()
        .find(|&&(_, max_fs, max_mbps, max_br)| mbs <= max_fs && mbps <= max_mbps && br <= max_br)
        .map(|&(level, ..)| level)
        .unwrap_or(62)
}

/// Thickness of the recording outline, in physical pixels.
///
/// Thin enough not to crowd the recorded area, thick enough to read as
/// deliberate at any DPI — a 1 px hairline reads as a rendering artefact
/// on a high-DPI display.
pub const OUTLINE_PX: u32 = 3;

/// Window rect for the recording outline: `region` grown by
/// [`OUTLINE_PX`] on every side, clamped to the virtual desktop.
///
/// Grown **outward** so the ring frames the recorded pixels rather than
/// covering their edge. The outline is capture-excluded and so never
/// lands in the file either way, but a border sitting *on* the content
/// would hide the very thing the user is checking the bounds of.
///
/// Clamping means a region flush against a screen edge loses the ring on
/// that side rather than having the window pushed inward, which would
/// misreport where the recording actually starts. An indicator that lies
/// about the bounds is worse than one that is clipped.
pub fn outline_frame(region: Region, virtual_w: u32, virtual_h: u32) -> Region {
    let x = region.x.saturating_sub(OUTLINE_PX);
    let y = region.y.saturating_sub(OUTLINE_PX);
    // Grow by however much was actually available on each leading edge,
    // plus the full thickness on the trailing edge, then clip to the
    // canvas.
    let grow_x = region.x - x;
    let grow_y = region.y - y;
    let width = region
        .width
        .saturating_add(grow_x)
        .saturating_add(OUTLINE_PX)
        .min(virtual_w.saturating_sub(x));
    let height = region
        .height
        .saturating_add(grow_y)
        .saturating_add(OUTLINE_PX)
        .min(virtual_h.saturating_sub(y));
    Region {
        x,
        y,
        width,
        height,
    }
}

/// Whether a session that has recorded `elapsed_ms` has hit its
/// format's ceiling and should commit.
pub fn duration_limit_reached(elapsed_ms: u64, format: RecorderFormat) -> bool {
    elapsed_ms >= format.max_duration_ms()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(x: u32, y: u32, width: u32, height: u32) -> Region {
        Region {
            x,
            y,
            width,
            height,
        }
    }

    fn request(target: RecorderTarget, format: RecorderFormat) -> RecorderRequest {
        RecorderRequest {
            target,
            region: Some(region(0, 0, 640, 480)),
            window_id: None,
            format,
            fps: None,
            audio: AudioSelection::default(),
            toggles: RecorderToggles::default(),
            output_dir: None,
            preset: None,
        }
    }

    // ---------- wire format ----------

    #[test]
    fn target_and_format_serialize_kebab_case() {
        assert_eq!(
            serde_json::to_string(&RecorderTarget::Fullscreen).unwrap(),
            "\"fullscreen\""
        );
        assert_eq!(
            serde_json::to_string(&RecorderFormat::Mp4).unwrap(),
            "\"mp4\""
        );
        let parsed: RecorderFormat = serde_json::from_str("\"gif\"").unwrap();
        assert_eq!(parsed, RecorderFormat::Gif);
    }

    #[test]
    fn a_minimal_request_parses() {
        // Everything but target and format is serde-defaulted, so the
        // frontend can start a fullscreen recording with two fields.
        let req: RecorderRequest =
            serde_json::from_str(r#"{"target":"fullscreen","format":"mp4"}"#).unwrap();
        assert_eq!(req.target, RecorderTarget::Fullscreen);
        assert_eq!(req.fps, None);
        assert!(!req.audio.any());
        assert!(!req.toggles.cursor);
    }

    #[test]
    fn status_and_result_are_camel_case() {
        let v = serde_json::to_value(RecorderStatus::idle()).unwrap();
        assert_eq!(v["state"], "idle");
        assert_eq!(v["elapsedMs"], 0);

        let result = RecorderResult {
            id: "rec_1".into(),
            target: RecorderTarget::Region,
            format: RecorderFormat::Mp4,
            width: 1920,
            height: 1080,
            path: "/tmp/a.mp4".into(),
            duration_ms: 4_200,
            frames: 126,
            has_audio: true,
            preview: false,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["durationMs"], 4_200);
        assert_eq!(v["hasAudio"], true);
        assert_eq!(v["format"], "mp4");
    }

    // ---------- format traits ----------

    #[test]
    fn extension_matches_what_the_library_classifies() {
        // The library decides a row's kind from the file extension, so
        // these two must agree or a recording lands as an `image`.
        use crate::library::{kind_of, CaptureKind};
        assert_eq!(
            kind_of(Some(RecorderFormat::Mp4.extension())),
            CaptureKind::Video
        );
        assert_eq!(
            kind_of(Some(RecorderFormat::Gif.extension())),
            CaptureKind::Gif
        );
    }

    #[test]
    fn only_mp4_carries_audio() {
        assert!(RecorderFormat::Mp4.supports_audio());
        assert!(!RecorderFormat::Gif.supports_audio());
    }

    // ---------- fps clamping ----------

    #[test]
    fn fps_falls_back_to_the_format_default() {
        assert_eq!(clamp_fps(None, RecorderFormat::Mp4), MP4_FPS_DEFAULT);
        assert_eq!(clamp_fps(None, RecorderFormat::Gif), GIF_FPS_DEFAULT);
        // Zero is a malformed value, not a request for a still.
        assert_eq!(clamp_fps(Some(0), RecorderFormat::Mp4), MP4_FPS_DEFAULT);
    }

    #[test]
    fn fps_clamps_into_each_formats_range() {
        assert_eq!(clamp_fps(Some(240), RecorderFormat::Mp4), MP4_FPS_MAX);
        assert_eq!(clamp_fps(Some(1), RecorderFormat::Mp4), MP4_FPS_MIN);
        // A 60 left over from an MP4 preset lands on GIF's lower ceiling
        // rather than being refused.
        assert_eq!(clamp_fps(Some(60), RecorderFormat::Gif), GIF_FPS_MAX);
        assert_eq!(clamp_fps(Some(24), RecorderFormat::Mp4), 24);
    }

    // ---------- dimensions ----------

    #[test]
    fn odd_dimensions_round_down_for_chroma_subsampling() {
        assert_eq!(even_dimensions(1921, 1081), (1920, 1080));
        assert_eq!(even_dimensions(1920, 1080), (1920, 1080));
        // Never rounds up — that would invent an edge pixel.
        assert_eq!(even_dimensions(3, 3), (2, 2));
    }

    // ---------- validation ----------

    #[test]
    fn validate_normalises_a_region_request() {
        let mut req = request(RecorderTarget::Region, RecorderFormat::Mp4);
        req.region = Some(region(10, 20, 641, 481));
        req.fps = Some(999);
        let v = validate(req, 1920, 1080, None).unwrap();
        assert_eq!(v.region, region(10, 20, 640, 480));
        assert_eq!(v.fps, MP4_FPS_MAX);
    }

    #[test]
    fn validate_clips_a_region_to_the_desktop() {
        let mut req = request(RecorderTarget::Region, RecorderFormat::Mp4);
        req.region = Some(region(1_800, 1_000, 640, 480));
        let v = validate(req, 1920, 1080, None).unwrap();
        assert_eq!(v.region, region(1_800, 1_000, 120, 80));
    }

    #[test]
    fn validate_rejects_an_area_below_the_minimum() {
        let mut req = request(RecorderTarget::Region, RecorderFormat::Mp4);
        req.region = Some(region(0, 0, 20, 20));
        assert!(validate(req, 1920, 1080, None).is_err());
    }

    #[test]
    fn fullscreen_takes_its_rectangle_from_the_resolved_monitor() {
        let mut req = request(RecorderTarget::Fullscreen, RecorderFormat::Mp4);
        // A stale region on the request is ignored for a fullscreen
        // session — the monitor is the source of truth.
        req.region = Some(region(0, 0, 100, 100));
        let v = validate(req, 3840, 2160, Some(region(1920, 0, 1920, 1080))).unwrap();
        assert_eq!(v.region, region(1920, 0, 1920, 1080));
    }

    #[test]
    fn fullscreen_without_a_monitor_is_an_error() {
        let req = request(RecorderTarget::Fullscreen, RecorderFormat::Mp4);
        assert!(validate(req, 1920, 1080, None).is_err());
    }

    #[test]
    fn region_target_without_a_region_is_an_error() {
        let mut req = request(RecorderTarget::Region, RecorderFormat::Mp4);
        req.region = None;
        assert!(validate(req, 1920, 1080, None).is_err());
    }

    #[test]
    fn clicks_imply_a_visible_cursor() {
        let mut req = request(RecorderTarget::Region, RecorderFormat::Mp4);
        req.toggles = RecorderToggles {
            cursor: false,
            clicks: true,
            preview: false,
            clipboard: false,
        };
        let v = validate(req, 1920, 1080, None).unwrap();
        assert!(v.toggles.cursor, "a click ring needs a pointer under it");
    }

    #[test]
    fn the_clipboard_toggle_survives_validation_for_both_formats() {
        // Unlike audio, this is not format-dependent: a GIF is as
        // pasteable as an MP4, so validation must not quietly drop it
        // the way it drops an audio selection for GIF.
        for format in [RecorderFormat::Mp4, RecorderFormat::Gif] {
            let mut req = request(RecorderTarget::Region, format);
            req.toggles = RecorderToggles {
                clipboard: true,
                ..Default::default()
            };
            let v = validate(req, 1920, 1080, None).unwrap();
            assert!(v.toggles.clipboard, "{format:?} lost the clipboard toggle");
        }
    }

    #[test]
    fn toggles_default_to_not_touching_the_clipboard() {
        // A recorder that replaces whatever the user had copied without
        // being asked is the same surprise the audio defaults avoid.
        assert!(!RecorderToggles::default().clipboard);
    }

    #[test]
    fn an_older_payload_without_the_clipboard_toggle_still_parses() {
        let t: RecorderToggles =
            serde_json::from_str(r#"{"cursor":true,"clicks":false,"preview":false}"#).unwrap();
        assert!(t.cursor);
        assert!(!t.clipboard);
    }

    #[test]
    fn gif_drops_audio_instead_of_refusing_the_recording() {
        let mut req = request(RecorderTarget::Region, RecorderFormat::Gif);
        req.audio = AudioSelection {
            microphone: true,
            system: true,
            microphone_device: Some("mic-1".into()),
            system_device: None,
        };
        let v = validate(req, 1920, 1080, None).unwrap();
        assert!(!v.audio.any());
        assert_eq!(v.audio.microphone_device, None);
    }

    #[test]
    fn mp4_keeps_the_audio_selection_intact() {
        let mut req = request(RecorderTarget::Region, RecorderFormat::Mp4);
        req.audio = AudioSelection {
            microphone: true,
            system: false,
            microphone_device: Some("mic-1".into()),
            system_device: None,
        };
        let v = validate(req, 1920, 1080, None).unwrap();
        assert!(v.audio.microphone);
        assert_eq!(v.audio.microphone_device.as_deref(), Some("mic-1"));
    }

    // ---------- timing ----------

    #[test]
    fn frame_interval_rounds_to_nearest_millisecond() {
        assert_eq!(frame_interval_ms(30), 33);
        assert_eq!(frame_interval_ms(60), 17);
        assert_eq!(frame_interval_ms(15), 67);
        // Never divides by zero.
        assert_eq!(frame_interval_ms(0), 1_000);
    }

    #[test]
    fn timestamps_convert_to_hundred_nanosecond_ticks() {
        assert_eq!(hns_from_millis(1_000), HNS_PER_SECOND);
        assert_eq!(hns_from_millis(0), 0);
        assert_eq!(frame_duration_hns(30), HNS_PER_SECOND / 30);
        assert_eq!(frame_duration_hns(0), HNS_PER_SECOND);
    }

    #[test]
    fn timestamps_do_not_overflow_on_a_long_session() {
        // Three hours of 100 ns ticks must stay well inside i64.
        let hns = hns_from_millis(MP4_MAX_DURATION_MS);
        assert!(hns > 0 && hns < i64::MAX / 2);
    }

    // ---------- GIF math ----------

    #[test]
    fn gif_delay_is_centiseconds_at_the_requested_rate() {
        assert_eq!(gif_frame_delay_cs(10), 10);
        assert_eq!(gif_frame_delay_cs(20), 5);
        assert_eq!(gif_frame_delay_cs(15), 7);
    }

    #[test]
    fn gif_delay_never_lands_on_the_viewer_override() {
        // 0 and 1 cs are the values viewers replace with their own
        // default; the clamp keeps playback at the speed we asked for.
        assert!(gif_frame_delay_cs(GIF_FPS_MAX) >= 2);
        assert!(gif_frame_delay_cs(1_000) >= 2);
    }

    #[test]
    fn gif_downscales_only_when_oversized() {
        assert_eq!(gif_target_size(640, 480), (640, 480));
        let (w, h) = gif_target_size(3840, 2160);
        // The area budget was chosen so a 16:9 recording lands exactly
        // where the old longest-edge rule put it — this is the
        // regression guard on "the common case didn't move".
        assert_eq!((w, h), (800, 450));
        assert_eq!(w % 2, 0);
        assert_eq!(h % 2, 0);
    }

    #[test]
    fn gif_downscale_keeps_a_tall_recording_upright() {
        let (w, h) = gif_target_size(1080, 1920);
        assert!(w < h);
        assert!(w as u64 * h as u64 <= GIF_MAX_PIXELS as u64);
    }

    #[test]
    fn gif_downscale_does_not_flatten_an_ultrawide_clip() {
        // The ultrawide fix. Under a longest-edge cap a 32:9 clip came
        // out 800×225 — the same pixel budget squeezed into a letterbox
        // with no vertical resolution left for text. Budgeting area
        // instead spends those pixels on both axes.
        let (w, h) = gif_target_size(5120, 1440);
        assert!(
            h > 300,
            "a 32:9 clip should keep usable height, got {w}×{h}"
        );
        // …without costing more than a 16:9 clip does.
        assert!(w as u64 * h as u64 <= GIF_MAX_PIXELS as u64);
        // Aspect ratio survives, to within the even-rounding.
        let ratio = w as f64 / h as f64;
        assert!((ratio - 5120.0 / 1440.0).abs() < 0.05, "ratio {ratio}");
    }

    #[test]
    fn gif_edge_cap_still_bounds_a_pathologically_thin_strip() {
        // Area alone would let this through at full width, because a
        // 50 px-tall strip is already inside the pixel budget.
        let (w, h) = gif_target_size(4000, 50);
        assert_eq!(w, GIF_MAX_EDGE);
        assert!(h >= 2);
    }

    // ---------- bitrate ----------

    #[test]
    fn bitrate_scales_with_pixels_and_rate() {
        let hd = video_bitrate_bps(1920, 1080, 30);
        let uhd = video_bitrate_bps(3840, 2160, 30);
        assert!(uhd > hd, "4K must ask for more than 1080p");
        assert!(video_bitrate_bps(1920, 1080, 60) > hd);
    }

    #[test]
    fn bitrate_stays_inside_its_bounds() {
        // A tiny region still gets enough bits for legible text.
        assert_eq!(video_bitrate_bps(64, 64, 10), BITRATE_MIN_BPS);
        // An 8K60 session is capped rather than asking for the disk.
        assert_eq!(video_bitrate_bps(7680, 4320, 60), BITRATE_MAX_BPS);
    }

    #[test]
    fn the_bitrate_ceiling_does_not_bind_on_a_real_ultrawide() {
        // The ceiling is a runaway guard. If it clamps a panel someone
        // owns, it has stopped being a guard and started being a
        // quality cap — which is what 40 Mbps was doing to 5120×2160.
        for (w, h) in [(3440, 1440), (5120, 1440), (5120, 2160), (3840, 2160)] {
            assert!(
                video_bitrate_bps(w, h, 60) < BITRATE_MAX_BPS,
                "{w}×{h}@60 is being clamped"
            );
        }
    }

    // ---------- H.264 level ----------

    #[test]
    fn h264_level_covers_ordinary_sizes_at_the_floor() {
        // 1080p60 fits inside 4.2, and nothing should push it higher —
        // a needlessly high level costs decoder compatibility.
        assert_eq!(h264_level(1920, 1080, 60, 8_000_000), 42);
    }

    #[test]
    fn h264_level_rises_for_ultrawide_frames() {
        // The bug this exists for: a >4096-wide frame with no stated
        // level gets one guessed for it, and some encoders guess too
        // small and then refuse the media type.
        let level = h264_level(5120, 1440, 60, video_bitrate_bps(5120, 1440, 60));
        assert!(level > 42, "5120×1440@60 needs more than level 4.2");

        // 5120×2160 is 43 200 macroblocks — past level 5.2's 36 864
        // MaxFS, so it has to reach level 6.
        assert!(h264_level(5120, 2160, 60, video_bitrate_bps(5120, 2160, 60)) >= 60);
    }

    #[test]
    fn h264_level_accounts_for_frame_rate_not_just_size() {
        // Same frame, more macroblocks per second: MaxMBPS binds even
        // when MaxFS doesn't.
        let slow = h264_level(3840, 2160, 24, 20_000_000);
        let fast = h264_level(3840, 2160, 60, 20_000_000);
        assert!(fast >= slow, "a faster frame rate cannot need a lower level");
        assert!(fast > 42);
    }

    #[test]
    fn h264_level_accounts_for_bitrate() {
        // Level 4.2 tops out at 20 Mbps; a small region asking for more
        // than that must not be pinned to a level that forbids it.
        assert!(h264_level(1280, 720, 30, 40_000_000) > 42);
    }

    #[test]
    fn h264_level_never_gives_up_on_an_absurd_frame() {
        // Past the spec's largest level we hand over the top code
        // rather than failing — the encoder can refuse with a real
        // message, which beats us refusing to record at all.
        assert_eq!(h264_level(30_000, 30_000, 240, 900_000_000), 62);
    }

    // ---------- recording outline ----------

    #[test]
    fn the_outline_frames_the_region_from_outside_it() {
        // Grown on every side, so the ring never covers the pixels the
        // user is checking the bounds of.
        let f = outline_frame(region(100, 100, 640, 480), 1920, 1080);
        assert_eq!(f, region(97, 97, 646, 486));
        assert_eq!(f.width, 640 + OUTLINE_PX * 2);
        assert_eq!(f.height, 480 + OUTLINE_PX * 2);
    }

    #[test]
    fn an_outline_at_the_top_left_corner_clips_rather_than_shifts() {
        // A region flush to the origin cannot grow up or left. The frame
        // must stay pinned there — pushing it inward would draw the ring
        // over the first rows of the recording and misreport where it
        // starts.
        let f = outline_frame(region(0, 0, 200, 150), 1920, 1080);
        assert_eq!(f.x, 0);
        assert_eq!(f.y, 0);
        // Only the trailing edges could grow.
        assert_eq!(f.width, 200 + OUTLINE_PX);
        assert_eq!(f.height, 150 + OUTLINE_PX);
    }

    #[test]
    fn an_outline_never_leaves_the_desktop() {
        // Bottom-right flush: the trailing growth has nowhere to go.
        let f = outline_frame(region(1720, 930, 200, 150), 1920, 1080);
        assert!(f.x + f.width <= 1920, "{f:?}");
        assert!(f.y + f.height <= 1080, "{f:?}");
        // …and it still grew outward on the leading edges.
        assert_eq!(f.x, 1720 - OUTLINE_PX);
        assert_eq!(f.y, 930 - OUTLINE_PX);
    }

    #[test]
    fn a_fullscreen_outline_is_the_whole_display() {
        // Nowhere to grow in any direction — the frame is the monitor,
        // and the ring reads as "this display is recording".
        let f = outline_frame(region(0, 0, 1920, 1080), 1920, 1080);
        assert_eq!(f, region(0, 0, 1920, 1080));
    }

    // ---------- limits ----------

    #[test]
    fn each_format_stops_at_its_own_ceiling() {
        assert!(duration_limit_reached(
            GIF_MAX_DURATION_MS,
            RecorderFormat::Gif
        ));
        // The same elapsed time is nowhere near MP4's ceiling.
        assert!(!duration_limit_reached(
            GIF_MAX_DURATION_MS,
            RecorderFormat::Mp4
        ));
        assert!(duration_limit_reached(
            MP4_MAX_DURATION_MS,
            RecorderFormat::Mp4
        ));
    }

    #[test]
    fn only_a_discard_throws_the_file_away() {
        assert!(!RecorderStopReason::Discarded.keeps_output());
        for reason in [
            RecorderStopReason::Committed,
            RecorderStopReason::DurationLimit,
            // A failure keeps what it has — the moment can't be re-recorded.
            RecorderStopReason::Failed,
        ] {
            assert!(reason.keeps_output(), "{reason:?} must keep its output");
        }
    }
}
