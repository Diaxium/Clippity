//! The `clippity-media` URI scheme — how a saved recording's bytes
//! reach the Studio player.
//!
//! Sibling to the `clippity-snapshot` handler in [`crate`], and it
//! exists separately for one reason: **a video is seeked, not
//! delivered.** The snapshot handler answers every request with a whole
//! PNG, which is right for an image the page shows all of at once. A
//! `<video>` element does the opposite — it asks for byte ranges, plays
//! them, and asks for different ones when the user drags the playhead.
//! Answering those with the whole file would mean holding a multi-
//! gigabyte recording in memory to serve the two seconds around the
//! playhead, and answering them with a plain `200` (however small the
//! body) makes the element believe the file is that short, so the
//! timeline collapses and seeking stops working.
//!
//! So this handler speaks the part of HTTP that makes seeking work:
//! `Accept-Ranges`, `206 Partial Content` with `Content-Range`, and
//! `416` for a range past the end. Everything it reads off disk is
//! bounded by [`MAX_RANGE_BYTES`] — a scheme handler returns an
//! in-memory `Vec<u8>`, so "stream it" is not available and the bound is
//! the only thing standing between a long recording and the allocator.
//!
//! Authorization is a [`MediaToken`], minted by `MediaService::probe`
//! after it validated the capture id against the captures root. The URL
//! never contains a path, so there is no path for the page to edit, and
//! this handler never has to re-derive whether a file is allowed to be
//! read — the token *is* that decision, already made.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::Manager;

use clippity_domain::media::MediaToken;

/// Largest slice served in one `206`.
///
/// A webview asks for `bytes=0-` (meaning "everything from here") and is
/// perfectly happy to be given a chunk and come back for more, so this
/// caps memory without capping playback. Eight mebibytes is several
/// seconds of a screen recording at any bitrate the encoder produces —
/// big enough that the request rate stays low, small enough that eight
/// concurrent ones still cost less than a frame buffer.
const MAX_RANGE_BYTES: u64 = 8 * 1024 * 1024;

/// Largest file served in one rangeless `200`.
///
/// A media element always sends a `Range`, so this path is for the
/// unusual caller — a `fetch`, or a URL opened directly. Truncating a
/// `200` would be a lie about the entity, so an oversized rangeless
/// request is refused rather than silently answered with part of a file.
const MAX_FULL_BYTES: u64 = 64 * 1024 * 1024;

/// Serve a ranged read of the clip a token stands for.
pub fn serve_media<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let app = ctx.app_handle().clone();
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    media_response(request.uri().path(), range.as_deref(), |token| {
        app.state::<crate::app::state::AppState>()
            .media_service
            .resolve(token)
    })
}

/// The handler's whole decision, separated from the Tauri runtime so it
/// can be tested — the same split `snapshot_response` uses, and for a
/// stronger reason: range arithmetic is off-by-one country, and every
/// mistake in it presents as "seeking is subtly broken" rather than as
/// an error anyone sees.
fn media_response(
    path: &str,
    range_header: Option<&str>,
    resolve: impl FnOnce(MediaToken) -> Option<std::path::PathBuf>,
) -> Response<Vec<u8>> {
    let Some(file) = MediaToken::from_path(path).and_then(resolve) else {
        return status(StatusCode::NOT_FOUND);
    };
    let Ok(total) = std::fs::metadata(&file).map(|m| m.len()) else {
        return status(StatusCode::NOT_FOUND);
    };
    let mime = mime_for(&file);

    let Some(header_value) = range_header else {
        // No `Range` — not a media element. Serve the whole thing, or
        // refuse if that would mean reading a recording into memory.
        if total > MAX_FULL_BYTES {
            return status(StatusCode::PAYLOAD_TOO_LARGE);
        }
        return match read_at(&file, 0, total) {
            Ok(bytes) => base(mime, total).status(StatusCode::OK).body(bytes),
            Err(_) => return status(StatusCode::NOT_FOUND),
        }
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR));
    };

    let Some(range) = ByteRange::parse(header_value, total) else {
        // Unsatisfiable — the spec wants the entity length back so the
        // client can correct itself rather than retry the same range.
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
            .header(header::ACCEPT_RANGES, "bytes")
            .body(Vec::new())
            .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR));
    };

    let length = range.len();
    let Ok(bytes) = read_at(&file, range.start, length) else {
        return status(StatusCode::NOT_FOUND);
    };

    base(mime, length)
        .status(StatusCode::PARTIAL_CONTENT)
        .header(
            header::CONTENT_RANGE,
            // Inclusive end, per RFC 9110 — `bytes 0-8388607/1000000000`.
            format!("bytes {}-{}/{}", range.start, range.end, total),
        )
        .body(bytes)
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

/// Headers every served body carries.
fn base(mime: &'static str, length: u64) -> tauri::http::response::Builder {
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        // Without this the element never *asks* for a range: it takes
        // the absence as "this server can't seek" and disables the
        // scrubber, which looks like a broken timeline rather than a
        // missing header.
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, length.to_string())
        // The Studio page and this scheme are separate origins.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        // Deliberately uncached, unlike the snapshot scheme. A token is
        // bound to a path, and a path's bytes are not immutable across a
        // session — a clip can be trashed and restored, and a trim
        // writes a new file into the same directory. Re-reading from a
        // local disk costs microseconds; serving a stale frame from
        // cache costs the user's trust in what they are looking at.
        .header(header::CACHE_CONTROL, "no-store")
}

/// An empty response with just a status.
fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .body(Vec::new())
        .expect("a status-only response always builds")
}

/// Read exactly `length` bytes starting at `start`.
///
/// Seeks rather than reading and slicing: the point of the whole handler
/// is that the bytes before the playhead are never touched.
fn read_at(path: &Path, start: u64, length: u64) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buffer = vec![0u8; length as usize];
    file.read_exact(&mut buffer)?;
    Ok(buffer)
}

/// Content type for a container extension.
///
/// Only the four the library classifies as video (`library::kind_of`),
/// because those are the only ones `MediaService::probe` will mint a
/// token for. An unknown extension gets the generic type rather than a
/// refusal — by the time a token exists the file has already been
/// probed and decoded successfully.
fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

/// A resolved, satisfiable byte range. `end` is **inclusive**, matching
/// the wire format so no conversion happens between parsing and the
/// `Content-Range` header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
}

impl ByteRange {
    fn len(self) -> u64 {
        self.end - self.start + 1
    }

    /// Parse a `Range` header against a known entity length.
    ///
    /// `None` means unsatisfiable (a `416`), which is distinct from
    /// "absent" — the caller has already handled that case.
    ///
    /// Handles the three forms RFC 9110 defines, and deliberately
    /// handles only the first of a multi-range request: a media element
    /// never sends one, and a partial implementation that answered the
    /// first range as though it were the whole request would corrupt
    /// playback for any client that did.
    fn parse(header: &str, total: u64) -> Option<Self> {
        let spec = header.trim().strip_prefix("bytes=")?.trim();
        if spec.contains(',') {
            return None;
        }
        let (start_text, end_text) = spec.split_once('-')?;
        let (start_text, end_text) = (start_text.trim(), end_text.trim());

        // An empty entity can satisfy no range at all.
        if total == 0 {
            return None;
        }
        let last = total - 1;

        let (start, end) = match (start_text.is_empty(), end_text.is_empty()) {
            // `bytes=-N` — the final N bytes. Used by players sniffing a
            // container's trailer, which is how a non-fragmented MP4's
            // index gets found.
            (true, false) => {
                let suffix: u64 = end_text.parse().ok()?;
                if suffix == 0 {
                    return None;
                }
                (total.saturating_sub(suffix), last)
            }
            // `bytes=N-` — everything from N. The opening request.
            (false, true) => (start_text.parse().ok()?, last),
            // `bytes=N-M` — an explicit window.
            (false, false) => (start_text.parse().ok()?, end_text.parse::<u64>().ok()?),
            (true, true) => return None,
        };

        if start > last || end < start {
            return None;
        }
        // Clamp the far end twice: to the entity, then to what one
        // response may carry. Clamping is not a partial answer — the
        // `Content-Range` states exactly what was sent, and the client
        // asks again for the rest.
        let end = end.min(last).min(start + MAX_RANGE_BYTES - 1);
        Some(Self { start, end })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    const TOTAL: u64 = 1_000;

    fn parse(header: &str) -> Option<ByteRange> {
        ByteRange::parse(header, TOTAL)
    }

    // ---------- range parsing ----------

    #[test]
    fn an_explicit_window_parses_inclusively() {
        // `bytes=0-499` is 500 bytes, not 499 — the classic off-by-one.
        let range = parse("bytes=0-499").expect("satisfiable");
        assert_eq!((range.start, range.end), (0, 499));
        assert_eq!(range.len(), 500);
    }

    #[test]
    fn an_open_ended_range_runs_to_the_last_byte() {
        // The opening request a media element sends.
        let range = parse("bytes=0-").expect("satisfiable");
        assert_eq!((range.start, range.end), (0, TOTAL - 1));
    }

    #[test]
    fn a_suffix_range_counts_back_from_the_end() {
        // How a player finds a container's trailer.
        let range = parse("bytes=-100").expect("satisfiable");
        assert_eq!((range.start, range.end), (900, 999));
        assert_eq!(range.len(), 100);
    }

    #[test]
    fn a_suffix_longer_than_the_file_is_the_whole_file() {
        let range = parse("bytes=-99999").expect("satisfiable");
        assert_eq!((range.start, range.end), (0, TOTAL - 1));
    }

    #[test]
    fn an_end_past_the_entity_is_clamped_to_it() {
        let range = parse("bytes=900-99999").expect("satisfiable");
        assert_eq!(range.end, TOTAL - 1);
    }

    #[test]
    fn a_start_past_the_entity_is_unsatisfiable() {
        assert_eq!(parse("bytes=1000-"), None);
        assert_eq!(parse("bytes=5000-6000"), None);
    }

    #[test]
    fn an_inverted_or_malformed_range_is_unsatisfiable() {
        for header in [
            "bytes=500-100", // end before start
            "bytes=-0",      // a zero-length suffix
            "bytes=-",       // no numbers at all
            "bytes=abc-def",
            "bytes=",
            "items=0-10", // not a byte range
            "0-10",       // no unit
        ] {
            assert_eq!(parse(header), None, "header {header:?}");
        }
    }

    #[test]
    fn a_multi_range_request_is_refused_rather_than_half_answered() {
        // Answering only the first range while claiming to have answered
        // the request would corrupt playback for a client that sent one.
        assert_eq!(parse("bytes=0-99,200-299"), None);
    }

    #[test]
    fn no_range_can_be_satisfied_against_an_empty_file() {
        assert_eq!(ByteRange::parse("bytes=0-", 0), None);
    }

    #[test]
    fn a_long_range_is_capped_so_one_response_stays_bounded() {
        // `bytes=0-` on a multi-gigabyte recording must not read a
        // multi-gigabyte Vec — see MAX_RANGE_BYTES.
        let huge = 4 * 1024 * 1024 * 1024;
        let range = ByteRange::parse("bytes=0-", huge).expect("satisfiable");
        assert_eq!(range.len(), MAX_RANGE_BYTES);
        assert_eq!(range.start, 0);
    }

    #[test]
    fn the_cap_applies_from_the_requested_start_not_the_file_start() {
        let huge = 4 * 1024 * 1024 * 1024;
        let range = ByteRange::parse("bytes=1000000-", huge).expect("satisfiable");
        assert_eq!(range.start, 1_000_000);
        assert_eq!(range.len(), MAX_RANGE_BYTES);
    }

    #[test]
    fn whitespace_around_the_spec_is_tolerated() {
        assert_eq!(parse(" bytes=0-99 "), Some(ByteRange { start: 0, end: 99 }));
    }

    // ---------- responses ----------

    struct TempClip(PathBuf);

    impl Drop for TempClip {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// Write a throwaway clip at a path no other test can be holding.
    ///
    /// The nonce is not decoration: `cargo test` runs these in parallel
    /// and a shared filename means one test reads another's bytes, or
    /// deletes the file mid-read. That failure looks exactly like a
    /// range bug, which is the one thing these tests exist to rule out.
    fn clip(bytes: &[u8]) -> TempClip {
        static NONCE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "clippity-scheme-{}-{}.mp4",
            std::process::id(),
            NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, bytes).unwrap();
        TempClip(path)
    }

    fn body(bytes: &[u8], path: &str, range: Option<&str>) -> Response<Vec<u8>> {
        let file = clip(bytes);
        let resolved = file.0.clone();
        media_response(path, range, |_| Some(resolved))
    }

    #[test]
    fn a_ranged_request_gets_exactly_those_bytes() {
        let data: Vec<u8> = (0..=255u8).collect();
        let res = body(&data, "/1", Some("bytes=10-19"));
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(res.body().as_slice(), &data[10..=19]);
        assert_eq!(res.headers()[header::CONTENT_RANGE], "bytes 10-19/256");
        assert_eq!(res.headers()[header::CONTENT_LENGTH], "10");
    }

    #[test]
    fn a_rangeless_request_gets_the_whole_file() {
        let data: Vec<u8> = (0..=255u8).collect();
        let res = body(&data, "/1", None);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body().as_slice(), data.as_slice());
    }

    #[test]
    fn every_response_advertises_range_support() {
        // Without this the element never asks for a range at all, and
        // the scrubber is dead — see `base`.
        let res = body(b"0123456789", "/1", Some("bytes=0-"));
        assert_eq!(res.headers()[header::ACCEPT_RANGES], "bytes");
    }

    #[test]
    fn an_unsatisfiable_range_reports_the_entity_length() {
        let res = body(b"0123456789", "/1", Some("bytes=500-600"));
        assert_eq!(res.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(res.headers()[header::CONTENT_RANGE], "bytes */10");
    }

    #[test]
    fn an_unknown_token_is_not_found() {
        let res = media_response("/7", Some("bytes=0-"), |_| None);
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert!(res.body().is_empty());
    }

    #[test]
    fn a_path_that_is_not_a_token_is_not_found() {
        for path in ["/", "", "/nope", "/1x"] {
            let file = clip(b"data");
            let resolved = file.0.clone();
            let res = media_response(path, None, |_| Some(resolved));
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "path {path:?}");
        }
    }

    #[test]
    fn a_resolved_but_deleted_file_is_not_found() {
        // The clip was trashed between probe and fetch.
        let res = media_response("/1", Some("bytes=0-"), |_| {
            Some(std::env::temp_dir().join("clippity-does-not-exist.mp4"))
        });
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn the_content_type_follows_the_container() {
        assert_eq!(mime_for(Path::new("a.mp4")), "video/mp4");
        assert_eq!(mime_for(Path::new("a.MP4")), "video/mp4");
        assert_eq!(mime_for(Path::new("a.webm")), "video/webm");
        assert_eq!(mime_for(Path::new("a.mov")), "video/quicktime");
        assert_eq!(mime_for(Path::new("a.mkv")), "video/x-matroska");
        assert_eq!(mime_for(Path::new("a.bin")), "application/octet-stream");
    }

    #[test]
    fn bytes_are_never_cached() {
        // A token names a path, and a path's bytes are not immutable
        // across a session — see `base`.
        let res = body(b"0123456789", "/1", Some("bytes=0-"));
        assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
    }
}
