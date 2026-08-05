# 0032 — Studio is a separate surface; it streams to play and re-encodes to trim

- **Status:** Accepted (implemented)
- **Date:** 2026-08-02
- **Area:** `app/backend/crates/domain/src/media.rs`,
  `app/backend/crates/platform/src/windows/media_reader.rs`,
  `app/backend/crates/services/src/media_service.rs`,
  `app/backend/crates/services/src/recorder_service/{sink.rs,mp4_sink.rs,gif_sink.rs}`,
  `app/backend/src-tauri/src/media_scheme.rs`,
  `app/backend/src-tauri/src/app/commands.rs`,
  `app/shared/src/contracts/media.ts`,
  `app/frontend/src/features/studio/`,
  `app/frontend/src/services/tauri/clients/media.ts`
- **Relates to:** [capture roadmap](../roadmaps/capture.md) **C1** (trim, the
  last of its three remainders after cursor effects and WebM),
  [editor-tools roadmap](../roadmaps/editor-tools.md) **E4** (the media
  surface those entries were waiting on),
  [0031 — recording is Media Foundation, one session two outputs](0031-recording-is-media-foundation-one-session-two-outputs.md)
  (whose sinks this reuses and whose bet it repeats on the decode side),
  [0026 — provenance sidecar](0026-capture-provenance-is-a-sidecar-written-at-the-save-choke-point.md)
  (a trimmed clip is a new capture and gets its own record)

## Context

Recording landed in July and the library filled with MP4s that could not be
opened. `captureActions.ts` deliberately withheld "Open in editor" from
`kind === "video"`, with a comment explaining that the annotation editor loads a
capture as an image and a video is not one — an honest dead end, and the right
call at the time. The Inspector's only affordance for a recording was "Play",
which shelled out to whatever the OS had registered.

So a recording could be made and never reviewed, and the roadmap's trim
(capture C1) had nowhere to live. Three questions had to be answered before any
of it could be written.

**Where does video editing go — into the editor, or beside it?** The editor is
a mature surface: a ~1400-line scene graph, twenty inspector sections, a
keybind registry, effects and sample regions.

**How do a recording's pixels reach the webview?** `editor_load` base64s a whole
PNG into a command's return value. A recording is three orders of magnitude
larger.

**What does a trim actually do to the bytes?**

## Decision

**Studio is a peer of the editor, not a mode of it.** The two share a job
description — explain a captured moment — and almost no machinery. The editor's
document is a graph of shapes over a still; Studio's is a clip, a playhead and
a range. Threading a time axis through every image-only path would cost more
than the components the merge would save. Reuse happens where it is real: both
surfaces read the `--ed-*` design tokens under `.clippity-editor`, and both
render as dashboard views (`DashboardView::Studio` joins `Editor`).

**Playback is a Range-serving URI scheme, not IPC.** A `<video>` element does
not want to be handed a file; it wants to *seek* into one, issuing ranged
requests as the user scrubs. So the bytes never cross the IPC bridge at all.
`media_probe` returns a description and a **token**; the webview fetches ranges
over `clippity-media://`, and `media_scheme.rs` answers with `206 Partial
Content`. Every response is bounded by `MAX_RANGE_BYTES` — a scheme handler
returns an in-memory `Vec<u8>`, so "stream it" is not on the table and the cap
is the only thing between a long recording and the allocator.

**A trim decodes and re-encodes; it does not remux.** Stream-copying would be
near-instant and lossless, and it loses on one point: a cut can only land on a
keyframe, so an in-point would silently move to the nearest one before it — up
to a couple of seconds on a screen recording. A trim UI whose handles are
decorative is worse than one that takes a moment, because the user cannot see
that it lied.

**The decoder feeds the recorder's existing sinks.** `sink::open` was narrowed
off `ValidatedRecorderRequest` onto a four-field `SinkConfig`, which is all
either sink ever read. A live session and a trim now build one and hand over
RGBA frames. **Trim-to-GIF therefore required no new encoder** — the format
fork is one argument, exactly as it is for a recording (ADR 0031).

Consequences that follow rather than being separate decisions:

- **The token is the authorization.** It is minted only by a successful
  `probe`, which has already run `library::validate_id`. The URL contains no
  path, so there is no path for the page to edit, and the scheme handler —
  which runs on webview input with no session context — never has to decide for
  itself whether a file may be read.
- **Playback bytes are `no-store`, unlike the snapshot scheme's `immutable`.**
  A snapshot id is minted per session so its bytes never change; a media token
  names a *path*, and a path's contents are not immutable across a session (a
  clip can be trashed and restored). Re-reading a local file costs microseconds;
  serving a stale frame costs the user's trust in what they are looking at.
- **Two clocks drive the playhead.** `requestAnimationFrame` reads
  `currentTime` at display rate, which is what a playhead needs to track
  smoothly. But rAF does not run when the page is hidden, and an occluded
  WebView2 window *is* hidden — so with the trim range enforced only there,
  minimising Studio mid-playback let the clip run past its out-point to the end
  of the file. `timeupdate` carries the correctness guarantee because it fires
  regardless of visibility; rAF carries the smoothness.
- **The range is enforced during playback only.** A paused playhead goes
  wherever it is put, so someone reviewing what a trim discards can scrub into
  the discarded part. Snapping them back would make the excluded footage
  unreachable the moment the handles moved.
- **Relative moves live in the store, not at the call sites.** A component
  computes its handler from the position it *rendered* with, so three rapid
  frame-step clicks in one tick all stepped from the same stale value and
  advanced a single frame. Reading the live position inside the action is what
  makes a button and its keyboard shortcut genuinely the same operation.
- **The decoder honours `MF_MT_DEFAULT_STRIDE`, including its sign.** An
  uncompressed RGB surface follows the GDI convention where a negative stride
  means bottom-up rows — the same trap ADR 0031 dodged on the writing side by
  feeding NV12. There is no such escape when reading (the caller wants RGBA),
  so the orientation is read from the negotiated media type rather than
  assumed. Assuming produces a file that is silently upside down.
- **GIF's duration ceiling is stated in the export control**, not discovered
  after an encode the user already waited for.
- **A trimmed clip is a new capture with `Trimmed` provenance.** It never
  overwrites its source — the same non-destructive rule the editor's scene
  sidecar follows, and for the same reason: the original frames are of a moment
  that cannot be re-recorded. The working file is dot-prefixed and in the
  destination directory, so the library scan skips a partial and the commit is
  a same-volume rename.
- **`AppError::Media` joins the error enum** with code `"media"`, separate from
  `"recorder"` because the recoveries have nothing in common: a failed
  recording is about a moment that is gone and a partial file to account for; a
  failed trim leaves the source untouched and can simply be retried.
- **`media_trim` runs on a blocking thread.** Media Foundation is `!Send` with
  no async surface, and parking an async-runtime worker for the length of an
  export would stall every other command.
- **Studio opens videos only.** A still has no time axis, and an animated GIF
  has one the platform decoder will not expose — so GIF keeps going to the
  editor, where it decodes as an image and flattening it is the user's choice.

### Rejected

- **A time axis on the editor's scene graph.** The tempting version of reuse,
  and it inverts the cost: every image-only code path would grow a dimension it
  never uses, to share components a separate surface can import anyway.
- **Tauri's built-in `asset:` protocol.** It handles ranges already, which is
  most of the work. It also needs runtime scope management for a captures
  directory the user can move, and it bypasses `validate_id` — the security
  boundary every other file-touching path in the app goes through.
- **A path in the playback URL, percent-encoded.** Stateless and simple, and it
  puts a filesystem path somewhere the page can edit, then relies on
  re-validating it on every ranged request.
- **A base64 data URI, as the editor uses.** Fails on size before it fails on
  anything else, and cannot seek at any size.
- **Remuxing with keyframe-snapped cuts.** See above; fast, lossless, and it
  makes the handles a suggestion.
- **Bundling FFmpeg.** Rejected for the recorder in ADR 0031 on installer
  weight, and reading changes nothing about that argument — Media Foundation
  decodes what it encoded.
- **Routing Studio's keys through the editor's keybind registry.** That
  registry exists to let the user rebind a hundred-odd annotation commands and
  resolve conflicts between them. Studio has nine bindings and no conflicts;
  wiring it in would mean teaching the registry about a second surface's
  context before there are commands to justify it.

## Consequences

- The library's "Open in editor" becomes **"Open in Studio"** for recordings,
  in both the context menu and the Inspector. The old absence was a deliberate
  dead end and its test asserted it; both now assert the routing instead.
- `MediaService` holds a bounded ring of eight live tokens. Studio shows one
  clip, but a webview keeps in-flight ranged requests against the *previous*
  clip alive briefly after the `src` changes, and a reload re-probes while the
  old element is tearing down.
- Trim decimates to the output rate rather than re-timing. A 60 fps source into
  a 15 fps GIF must drop three frames in four, or the file carries four times
  the frames each holding for a fifteenth of a second — a clip four times too
  long.
- Audio duration comes from the sample count, never the clock, matching ADR
  0031's rule for the same reason.
- **The pipeline is verified against real hardware, not just compiled.** Four
  `#[ignore]`d tests do the things that compile perfectly and fail at runtime:
  an encode → probe round trip in `clippity-platform` (which closes the loop
  between the two halves — a geometry or rate mismatch is invisible to either
  side's own tests), and encode → trim → re-probe, trim-to-GIF, and progress
  coverage in `clippity-services`. Run them after touching the decoder, the
  sinks or the trim loop:
  `cargo test -p clippity-platform -- --ignored` and
  `cargo test -p clippity-services -- --ignored`.
- Not attempted, and deliberately not faked: **timeline annotation** (E4's
  other half — callouts and redaction with time ranges), **multi-clip
  assembly**, **WebM**, and **cursor/click effects**. Studio is a place to
  review and cut a recording, not to compose one.
