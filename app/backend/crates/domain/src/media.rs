//! Media playback and trimming — the pure rules behind the Studio
//! surface.
//!
//! Studio is where a *recording* is reviewed and cut, the way the editor
//! is where a *screenshot* is annotated. This module owns what can be
//! decided without touching a decoder: what a clip's timeline looks
//! like, which slice of it a trim names, and whether that slice is a
//! thing the requested output format can actually hold.
//!
//! The split from [`crate::recorder`] is deliberate and narrow. That
//! module describes a session that *produces* frames from the screen;
//! this one describes a file that *already has* them. They meet at the
//! output end — a trim is encoded by the very same sinks a recording is,
//! so every ceiling this module enforces is imported from there rather
//! than restated, and a change to GIF's duration limit moves both.

use serde::{Deserialize, Serialize};

use crate::annotation::{OverlayRef, Redaction};
use crate::recorder::{self, RecorderFormat};

/// Frame rate assumed when a file doesn't declare one.
///
/// A container is allowed to omit the frame rate, and a variable-frame-rate
/// recording genuinely has no single answer. The number is not used for
/// decoding — the decoder reads real timestamps — only for the two places
/// the UI needs a grid: how far one "step a frame" press moves, and what
/// a frame count in the transport reads as. Guessing 30 makes those
/// controls work sensibly on a file that won't say; the alternative is
/// disabling frame stepping on exactly the clips most likely to need it.
pub const ASSUMED_FPS: u32 = 30;

/// Shortest trim worth encoding, in milliseconds.
///
/// Below this the output is a file with one or two frames in it, which
/// is a screenshot taken the hard way. Rejecting is friendlier than
/// producing it: the user has almost certainly dragged a handle by
/// accident, and a 30 ms MP4 looks like a bug in the trim rather than a
/// faithful reading of the range.
pub const MIN_TRIM_MS: u64 = 200;

/// What playback and the timeline need to know about an opened clip.
///
/// Everything here is read once, when Studio opens the file, and never
/// again — the `<video>` element owns playback position from then on.
/// The fields exist because the timeline has to be drawn *before* the
/// first frame decodes: a ruler needs the duration, the stage needs the
/// aspect ratio to reserve its box, and the transport needs to know
/// whether to show an audio control at all.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// The capture id (absolute path) this describes.
    pub id: String,
    /// Handle the webview fetches the bytes with, on the
    /// `clippity-media` scheme. Not a file path and not a URL: the
    /// frontend turns it into one through Tauri's `convertFileSrc`,
    /// which is the only party that knows the platform's scheme-URL
    /// shape. Same split as the overlay's snapshot id. See
    /// [`MediaToken`].
    pub token: MediaToken,
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    /// Nominal frame rate, or [`ASSUMED_FPS`] when the file doesn't
    /// declare one. Never zero — a zero here would divide by zero in
    /// every frame-stepping calculation downstream.
    pub fps: u32,
    /// Whether the file carries an audio stream. Drives whether the
    /// transport shows a volume control, and whether a trim bothers
    /// decoding audio.
    pub has_audio: bool,
}

impl MediaInfo {
    /// Total frames on the timeline's grid.
    ///
    /// Derived from the duration and the nominal rate rather than
    /// counted, because counting means decoding the whole file — a
    /// multi-second stall to open a clip, to produce a number only the
    /// transport's readout uses.
    pub fn frame_count(&self) -> u64 {
        (self.duration_ms.saturating_mul(self.fps as u64)) / 1_000
    }
}

/// Opaque handle the webview uses to fetch a clip's bytes.
///
/// The playback URL carries one of these instead of the file path, for
/// the same reason [`crate::library::validate_id`] exists: a path in a
/// URL is a path the page can edit. A token is minted only by a
/// successful `probe`, which has already validated the id against the
/// captures root, so the scheme handler serves bytes without having to
/// re-derive whether it is allowed to.
///
/// Monotonic, never reused within a run — a stale URL left in the
/// webview's cache resolves to a 404 rather than to whatever clip
/// happens to hold that slot now, exactly as the snapshot scheme's ids
/// behave.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct MediaToken(pub u64);

impl MediaToken {
    /// The URL path a token is fetched at. One definition so the minting
    /// side and the parsing side cannot disagree about the shape.
    pub fn path(self) -> String {
        format!("/{}", self.0)
    }

    /// Recover a token from a scheme URL's path. `None` for anything
    /// that isn't `/<digits>`.
    pub fn from_path(path: &str) -> Option<Self> {
        path.rsplit('/').next()?.parse::<u64>().ok().map(MediaToken)
    }
}

/// A trim as the frontend asks for it — unchecked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimRequest {
    /// Capture id of the source clip.
    pub id: String,
    /// In-point, milliseconds from the start of the source.
    pub start_ms: u64,
    /// Out-point, milliseconds from the start of the source. Exclusive:
    /// the exported clip is `[start, end)`, so `end - start` is exactly
    /// its duration and two adjacent trims tile without overlapping.
    pub end_ms: u64,
    pub format: RecorderFormat,
    /// Output frame rate. `None` keeps the source's rate for MP4 and
    /// takes the format default for GIF.
    pub fps: Option<u32>,
    /// Drop the audio track even though the source has one. Ignored for
    /// GIF, which has nowhere to put it.
    pub mute: bool,
    /// Redactions to burn in, timed against the **source** clip.
    ///
    /// Defaulted so a request that predates annotations — or a caller
    /// that has none — is unchanged on the wire.
    #[serde(default)]
    pub redactions: Vec<Redaction>,
    /// Pre-rendered overlay bitmaps to composite, also timed against the
    /// source. One per interval between annotation boundaries.
    #[serde(default)]
    pub overlays: Vec<OverlayRef>,
}

/// A trim that has been checked against the source it names.
///
/// Constructed only by [`validate_trim`]. Carrying validity in the type
/// is what lets the export path index into a decoder without re-deriving
/// whether the range is inside the file.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedTrim {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub format: RecorderFormat,
    pub fps: u32,
    /// Whether to decode and re-encode audio. False when the source has
    /// none, when the user muted it, or when the format can't hold it —
    /// the three collapse here so the export loop never branches again.
    pub with_audio: bool,
    /// Size of the frames the **decoder** will produce, rounded to even
    /// edges (H.264's 4:2:0 chroma cannot describe an odd one).
    ///
    /// Not the output size. A sink is handed source frames and applies
    /// its own format's rules to them — GIF scales down internally,
    /// because quantizing at full resolution and shrinking afterwards
    /// would both waste the frame budget and blend palette entries into
    /// colours that were never in the palette. Ask [`Self::output_size`]
    /// for what the file will actually contain.
    pub width: u32,
    pub height: u32,
    /// Redactions to burn in. **Timed against the source clip**, not the
    /// output — the user authored them on the source's timeline in
    /// Studio, so a trim starting at 0:30 must look them up by the
    /// frame's own timestamp rather than by its position in the export.
    /// Getting that backwards shifts every annotation by the in-point.
    pub redactions: Vec<Redaction>,
    /// Overlay bitmaps to composite, on the same source timeline.
    pub overlays: Vec<OverlayRef>,
}

impl ValidatedTrim {
    /// Whether this trim has anything to burn in. The export path skips
    /// its whole annotation stage when false, so an ordinary trim costs
    /// exactly what it did before annotations existed.
    pub fn has_annotations(&self) -> bool {
        !self.redactions.is_empty() || !self.overlays.is_empty()
    }

    /// Duration of the exported clip.
    pub fn duration_ms(&self) -> u64 {
        self.end_ms - self.start_ms
    }

    /// Frame size the finished file will have.
    ///
    /// Applies the same rule the sink will — one function so the size
    /// reported back to the user cannot disagree with the size on disk.
    pub fn output_size(&self) -> (u32, u32) {
        match self.format {
            RecorderFormat::Mp4 => (self.width, self.height),
            RecorderFormat::Gif => recorder::gif_target_size(self.width, self.height),
        }
    }
}

/// Why a requested trim can't be encoded.
///
/// An enum rather than a string because two of these are *offers*, not
/// refusals: the UI can propose shortening a range that overruns GIF's
/// ceiling, which it can only do if it knows the ceiling was the
/// problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrimError {
    /// Out-point at or before the in-point.
    Inverted,
    /// Range shorter than [`MIN_TRIM_MS`].
    TooShort { min_ms: u64 },
    /// Longer than the output format allows. Carries the ceiling so the
    /// UI can offer to clip the range to it.
    TooLong { max_ms: u64, format: RecorderFormat },
}

impl std::fmt::Display for TrimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrimError::Inverted => {
                write!(f, "the out-point must come after the in-point")
            }
            TrimError::TooShort { min_ms } => {
                write!(f, "a trim must be at least {min_ms} ms long")
            }
            TrimError::TooLong { max_ms, format } => write!(
                f,
                "{} cannot hold more than {} seconds",
                match format {
                    RecorderFormat::Mp4 => "MP4",
                    RecorderFormat::Gif => "GIF",
                },
                max_ms / 1_000
            ),
        }
    }
}

/// Check a trim against the clip it cuts, resolving every "or the
/// default" into a concrete number.
///
/// The range is **clamped** to the source rather than rejected for
/// overrunning it: a timeline drag that ends a pixel past the end of a
/// clip means "to the end", not "error". Ordering and length, by
/// contrast, are refused — those are the cases where guessing what the
/// user meant would silently produce a different clip than the one the
/// handles showed.
pub fn validate_trim(
    request: &TrimRequest,
    source: &MediaInfo,
) -> Result<ValidatedTrim, TrimError> {
    let duration = source.duration_ms;
    let start = request.start_ms.min(duration);
    let end = request.end_ms.min(duration);

    if end <= start {
        return Err(TrimError::Inverted);
    }
    if end - start < MIN_TRIM_MS {
        return Err(TrimError::TooShort {
            min_ms: MIN_TRIM_MS,
        });
    }
    let max_ms = request.format.max_duration_ms();
    if end - start > max_ms {
        return Err(TrimError::TooLong {
            max_ms,
            format: request.format,
        });
    }

    // The source's own rate is the natural default for MP4 — re-encoding
    // a 60 fps capture at the format's 30 fps default would quietly
    // halve its smoothness. GIF has no such option: its ceiling is far
    // below a typical recording's rate, so it always takes the format's.
    let requested_fps = request.fps.or(match request.format {
        RecorderFormat::Mp4 => Some(source.fps),
        RecorderFormat::Gif => None,
    });
    let fps = recorder::clamp_fps(requested_fps, request.format);

    // The size the decoder yields, for either format. What the *file*
    // ends up being is the sink's business — see `output_size`.
    let (width, height) = recorder::even_dimensions(source.width, source.height);

    Ok(ValidatedTrim {
        id: request.id.clone(),
        start_ms: start,
        end_ms: end,
        format: request.format,
        fps,
        with_audio: source.has_audio && !request.mute && request.format.supports_audio(),
        width,
        height,
        // Passed through untouched. An annotation outside the trimmed
        // range is not an error and not worth filtering here: the export
        // asks "does this cover the frame in hand", which answers it.
        redactions: request.redactions.clone(),
        overlays: request.overlays.clone(),
    })
}

/// Progress of a running trim, for the `media/trim-progress` event.
///
/// Reported as encoded-milliseconds rather than a percentage so the UI
/// can show a real position on the same timeline the user set the
/// handles on, and so a percentage — which needs the total anyway — can
/// still be derived.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimProgress {
    /// Milliseconds of the output written so far.
    pub encoded_ms: u64,
    /// Total milliseconds the output will contain.
    pub total_ms: u64,
}

impl TrimProgress {
    /// Fraction complete in `0.0..=1.0`. Zero-length totals report 0
    /// rather than dividing — validation forbids them, but a progress
    /// readout is the wrong place to discover that.
    pub fn fraction(&self) -> f32 {
        if self.total_ms == 0 {
            return 0.0;
        }
        (self.encoded_ms as f32 / self.total_ms as f32).clamp(0.0, 1.0)
    }
}

/// What a finished trim produced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimResult {
    /// Absolute path of the new clip. A trim never writes over its
    /// source — the same non-destructive rule the editor's scene
    /// sidecar follows, and for the same reason: the original frames
    /// are of a moment that cannot be re-recorded.
    pub path: String,
    pub format: RecorderFormat,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> MediaInfo {
        MediaInfo {
            id: "C:/caps/Rec.mp4".into(),
            token: MediaToken(1),
            width: 1920,
            height: 1080,
            duration_ms: 120_000,
            fps: 60,
            has_audio: true,
        }
    }

    fn request(start_ms: u64, end_ms: u64) -> TrimRequest {
        TrimRequest {
            id: "C:/caps/Rec.mp4".into(),
            start_ms,
            end_ms,
            format: RecorderFormat::Mp4,
            fps: None,
            mute: false,
            redactions: Vec::new(),
            overlays: Vec::new(),
        }
    }

    // ---------- MediaInfo ----------

    #[test]
    fn frame_count_is_the_duration_on_the_nominal_grid() {
        assert_eq!(source().frame_count(), 7_200);
    }

    // ---------- MediaToken ----------

    #[test]
    fn a_token_round_trips_through_its_url_path() {
        let token = MediaToken(42);
        assert_eq!(token.path(), "/42");
        assert_eq!(MediaToken::from_path(&token.path()), Some(token));
    }

    #[test]
    fn a_path_that_is_not_a_token_does_not_parse() {
        for path in ["/", "", "/nope", "/1x", "/-1", "/1.5"] {
            assert_eq!(MediaToken::from_path(path), None, "path {path:?}");
        }
    }

    // ---------- validate_trim ----------

    #[test]
    fn a_range_inside_the_clip_survives_intact() {
        let trim = validate_trim(&request(5_000, 15_000), &source()).expect("valid");
        assert_eq!((trim.start_ms, trim.end_ms), (5_000, 15_000));
        assert_eq!(trim.duration_ms(), 10_000);
    }

    #[test]
    fn a_range_running_past_the_end_is_clamped_not_refused() {
        // A drag that overshoots the end of the timeline means "to the
        // end" — see `validate_trim`.
        let trim = validate_trim(&request(110_000, 999_000), &source()).expect("valid");
        assert_eq!(trim.end_ms, 120_000);
    }

    #[test]
    fn an_inverted_range_is_refused() {
        assert_eq!(
            validate_trim(&request(9_000, 3_000), &source()),
            Err(TrimError::Inverted)
        );
        assert_eq!(
            validate_trim(&request(9_000, 9_000), &source()),
            Err(TrimError::Inverted)
        );
    }

    #[test]
    fn a_range_shorter_than_the_floor_is_refused() {
        assert_eq!(
            validate_trim(&request(1_000, 1_000 + MIN_TRIM_MS - 1), &source()),
            Err(TrimError::TooShort {
                min_ms: MIN_TRIM_MS
            })
        );
    }

    #[test]
    fn a_gif_longer_than_the_format_allows_reports_the_ceiling() {
        let mut req = request(0, 120_000);
        req.format = RecorderFormat::Gif;
        let err = validate_trim(&req, &source()).unwrap_err();
        assert_eq!(
            err,
            TrimError::TooLong {
                max_ms: recorder::GIF_MAX_DURATION_MS,
                format: RecorderFormat::Gif,
            }
        );
        // The UI offers to shorten the range, so the message has to name
        // the limit rather than just refusing.
        assert!(err.to_string().contains("60 seconds"), "got {err}");
    }

    // ---------- resolved output settings ----------

    #[test]
    fn mp4_keeps_the_sources_frame_rate_by_default() {
        // Not the format default: re-encoding a 60 fps capture at 30
        // would quietly halve its smoothness.
        let trim = validate_trim(&request(0, 10_000), &source()).expect("valid");
        assert_eq!(trim.fps, 60);
    }

    #[test]
    fn gif_takes_the_format_default_rate() {
        let mut req = request(0, 10_000);
        req.format = RecorderFormat::Gif;
        assert_eq!(
            validate_trim(&req, &source()).unwrap().fps,
            recorder::GIF_FPS_DEFAULT
        );
    }

    #[test]
    fn the_decoded_size_is_the_source_and_only_the_output_shrinks_for_gif() {
        // The distinction that keeps the sink and the reported result in
        // agreement: frames arrive full-size and GIF scales them itself.
        let mut req = request(0, 10_000);
        req.format = RecorderFormat::Gif;
        let trim = validate_trim(&req, &source()).expect("valid");
        assert_eq!((trim.width, trim.height), (1920, 1080), "decoded size");
        let (out_w, out_h) = trim.output_size();
        assert!(out_w < 1920 && out_h < 1080, "GIF output {out_w}x{out_h}");
        assert_eq!(out_w % 2, 0, "even edges survive the scale");
    }

    #[test]
    fn an_mp4s_output_is_the_size_it_decoded() {
        let trim = validate_trim(&request(0, 10_000), &source()).expect("valid");
        assert_eq!(trim.output_size(), (trim.width, trim.height));
    }

    #[test]
    fn an_explicit_frame_rate_is_clamped_to_the_formats_range() {
        let mut req = request(0, 10_000);
        req.fps = Some(9_000);
        assert_eq!(
            validate_trim(&req, &source()).unwrap().fps,
            recorder::MP4_FPS_MAX
        );
    }

    #[test]
    fn mp4_output_dimensions_are_even() {
        // H.264's 4:2:0 chroma cannot describe an odd edge — an odd
        // source has to round before it reaches the encoder.
        let mut src = source();
        src.width = 1921;
        src.height = 1081;
        let trim = validate_trim(&request(0, 10_000), &src).expect("valid");
        assert_eq!(trim.width % 2, 0);
        assert_eq!(trim.height % 2, 0);
    }

    // ---------- audio resolution ----------

    #[test]
    fn audio_is_dropped_when_muted_when_absent_or_when_gif() {
        let silent = MediaInfo {
            has_audio: false,
            ..source()
        };
        assert!(
            !validate_trim(&request(0, 10_000), &silent)
                .unwrap()
                .with_audio
        );

        let mut muted = request(0, 10_000);
        muted.mute = true;
        assert!(!validate_trim(&muted, &source()).unwrap().with_audio);

        let mut gif = request(0, 10_000);
        gif.format = RecorderFormat::Gif;
        assert!(!validate_trim(&gif, &source()).unwrap().with_audio);

        // …and kept in the one case where all three allow it.
        assert!(
            validate_trim(&request(0, 10_000), &source())
                .unwrap()
                .with_audio
        );
    }

    // ---------- annotations ----------

    #[test]
    fn a_trim_carries_its_annotations_through_validation_untouched() {
        use crate::annotation::{NormRect, RedactionMode};

        let mut req = request(30_000, 40_000);
        req.redactions = vec![Redaction {
            rect: NormRect {
                x: 0.1,
                y: 0.1,
                w: 0.2,
                h: 0.2,
            },
            mode: RedactionMode::Blur { radius: 6 },
            // Deliberately outside the trimmed range: the export asks
            // whether an annotation covers the frame in hand, so nothing
            // here needs to filter them.
            start_ms: 0,
            end_ms: 5_000,
        }];
        req.overlays = vec![OverlayRef {
            path: "C:/tmp/a.png".into(),
            start_ms: 30_000,
            end_ms: 35_000,
        }];

        let trim = validate_trim(&req, &source()).expect("valid");
        assert_eq!(trim.redactions, req.redactions);
        assert_eq!(trim.overlays, req.overlays);
        // Source-relative, so the in-point must not have shifted them.
        assert_eq!(trim.overlays[0].start_ms, 30_000);
    }

    #[test]
    fn a_trim_without_annotations_reports_nothing_to_burn_in() {
        // What lets the export path skip its whole annotation stage, so
        // an ordinary trim costs what it always did.
        let plain = validate_trim(&request(0, 10_000), &source()).expect("valid");
        assert!(!plain.has_annotations());

        let mut req = request(0, 10_000);
        req.overlays = vec![OverlayRef {
            path: "a.png".into(),
            start_ms: 0,
            end_ms: 1_000,
        }];
        assert!(validate_trim(&req, &source()).unwrap().has_annotations());
    }

    #[test]
    fn a_request_that_names_no_annotations_still_deserializes() {
        // The fields are additive, so a payload written before they
        // existed — or by a caller with nothing to burn in — must not
        // fail to parse.
        let json = r#"{
            "id": "C:/caps/Rec.mp4",
            "startMs": 0,
            "endMs": 5000,
            "format": "mp4",
            "fps": null,
            "mute": false
        }"#;
        let req: TrimRequest = serde_json::from_str(json).expect("parses without annotations");
        assert!(req.redactions.is_empty());
        assert!(req.overlays.is_empty());
    }

    // ---------- TrimProgress ----------

    #[test]
    fn progress_is_a_clamped_fraction() {
        let at = |encoded_ms| {
            TrimProgress {
                encoded_ms,
                total_ms: 10_000,
            }
            .fraction()
        };
        assert_eq!(at(0), 0.0);
        assert_eq!(at(5_000), 0.5);
        // An encoder can overrun the nominal total by a frame; the bar
        // must not exceed full.
        assert_eq!(at(11_000), 1.0);
    }

    #[test]
    fn progress_on_a_zero_length_total_does_not_divide_by_zero() {
        assert_eq!(
            TrimProgress {
                encoded_ms: 0,
                total_ms: 0
            }
            .fraction(),
            0.0
        );
    }
}
