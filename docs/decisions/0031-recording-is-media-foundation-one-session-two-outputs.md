# 0031 — Recording encodes through Media Foundation; one session, two outputs

- **Status:** Accepted (implemented)
- **Date:** 2026-07-25
- **Area:** `app/backend/crates/domain/src/recorder.rs`,
  `app/backend/crates/platform/src/windows/{media_foundation.rs,nv12.rs,audio.rs,pcm.rs}`,
  `app/backend/crates/services/src/recorder_service{.rs,/sink.rs,/mp4_sink.rs,/gif_sink.rs}`,
  `app/backend/crates/services/src/{capture_io.rs,sidecar.rs,library_service.rs}`,
  `app/backend/src-tauri/src/app/{commands.rs,state.rs}`,
  `app/shared/src/contracts/recorder.ts`,
  `app/frontend/src/features/toast/components/RecorderToastBody.tsx`,
  `app/frontend/src/features/home/{lib/quickCapture.ts,hooks/useQuickCapture.ts}`
- **Relates to:** [capture roadmap](../roadmaps/capture.md) **C1 (recorder beta)**,
  [0008 — scrolling-window recording](../roadmaps/capture.md) (the session
  silhouette this borrows and the naming it forced apart),
  [0026 — provenance sidecar](0026-capture-provenance-is-a-sidecar-written-at-the-save-choke-point.md)
  (extended with a fourth family and a file-promotion choke point),
  [performance roadmap](../roadmaps/performance.md) P1 (per-event routing)

## Context

`CaptureKind` has carried `video` and `gif` since the library's first scan, and
the Home launcher has shown Record and GIF cards marked "Soon" for as long. The
capture roadmap's C1 asks for region/window/fullscreen video, mic and system
audio, pause/stop, a crash-safe partial file, and MP4 **and** GIF output.

Frame acquisition was already solved — `xcap` is a dependency and grabs a
monitor region directly. Nothing else was. Three questions had to be answered
before a line of it could be written.

**What encodes H.264?** Nothing in the tree could. The realistic options were
an FFmpeg sidecar, a pure-Rust encoder, or the encoders Windows already ships.

**Is GIF a second recorder or a second encoder?** The Home cards imply two
features. The pipelines up to the encoder are identical.

**What happens to a recording the process doesn't survive?** A screenshot that
fails can be retaken. A recording is of a moment that is gone.

## Decision

**Encode through Media Foundation** — `IMFSinkWriter` with an H.264 video
stream and an AAC audio stream, driven from `clippity-platform`. Windows ships
both encoders and uses the GPU's when there is one. It costs this codebase one
file of COM plumbing and adds **nothing** to the installer.

**One session, two outputs.** A recording is captured once; `RecorderFormat`
picks which encoder the frames land in. The fork is a single trait,
`recorder_service::sink::RecordingSink`, and everything before it — target
resolution, frame pacing, the pause clock, audio mixing, the HUD's status — is
shared. The Record and GIF launcher cards are one argument apart.

**Feed the encoder NV12, not RGB32.** Media Foundation will take RGB32 and
insert its colour converter, but that path inherits the GDI convention where an
uncompressed RGB surface is bottom-up unless the stride says otherwise. A
top-down capture buffer then records **silently upside down** — a valid file,
just inverted. NV12 has no such convention. The conversion (`platform::nv12`)
is ours, which also makes the pixel path a pure function with unit tests
covering studio-swing endpoints, channel order and chroma averaging, rather
than a thing only checkable by watching a recording back.

**The container is fragmented MP4.** A plain MP4 whose `moov` box never gets
written is not a short recording — every byte is on disk and no player can read
any of it. Fragments are self-describing as they land, so a process that dies
mid-session leaves a file that plays up to the last one.

**Everything streams; nothing accumulates.** Neither format buffers frames. GIF
in particular quantizes per frame with a local palette rather than collecting
every frame for one global palette: at its duration ceiling that frame set is
around a gigabyte, which would make a long GIF a memory-exhaustion bug instead
of a big file. Local palettes are native to the format and, on screen content,
close to indistinguishable.

**Named `recorder`, never `recording`.** `domain::scroll` already owns a
"recording": the scrolling/panoramic stitcher, with `clippity://recording/*`
events and a `RecordingToastBody`. That session turns many frames into a
**still image**; this one turns them into a video. They share a silhouette and
nothing else, so they get separate modules, separate `clippity://recorder/*`
events and separate HUDs.

Consequences that follow rather than being separate decisions:

- **Audio timestamps come from the sample count, video's from the wall clock.**
  The sample rate *is* the audio clock; deriving its timeline from anything
  else is how tracks drift. `pcm::StereoResampler` is stateful for the same
  reason — restarting phase per WASAPI packet re-samples every packet seam and
  accumulates into exactly the drift C1 budgets 100 ms for.
- **Audio degrades, never fails.** A denied microphone does not cost the user
  their system audio, and neither costs them the video. `RecorderResult.has_audio`
  reports what was *written*, not what was requested, so the toast can say so
  rather than the user finding the silence on playback.
- **`recorder/finished` is emitted by the worker, not by `stop`.** A session can
  end with nobody having called anything — a duration ceiling, a failed encoder.
  The worker is the only party present on every exit path; the HUD listens and
  calls `stop` to reap, so a pressed button and a self-stop converge.
- **The working file is dot-prefixed and lives in the destination directory**,
  so the library scan skips an in-progress (or crash-orphaned) recording, and
  the commit is a same-volume rename rather than a copy of gigabytes.
- **A fourth sidecar family, `.posters`.** A video is not a decodable image, so
  the recorder writes its first frame beside the file and `library_service`
  falls back to it. Keyed on *decode failure*, not on extension — a GIF decodes
  natively and keeps using the real file.

### Rejected

- **Bundling FFmpeg.** Easiest to get working and the best format coverage, and
  the reason it lost is the installer: 70–100 MB onto a payload that
  [the installer project](../installer/00-final-report.md) exists to keep
  tight, plus LGPL/GPL attribution and a subprocess to babysit. Worth
  revisiting only if a format Media Foundation cannot reach becomes necessary.
- **A pure-Rust encoder** (`openh264`, `rav1e` + the `mp4` crate). No
  subprocess and cross-platform, but software-only encode is far too slow at
  1080p60, and `openh264` pulls a prebuilt binary blob for patent reasons —
  which is the installer objection again, wearing a hat.
- **Record MP4 always, export GIF later.** Makes GIF a re-tunable operation on
  a saved file, which is genuinely nicer. It also requires decoding H.264 back
  out to get the frames, and defers GIF's much lower frame-rate and duration
  ceilings from record time to export time — so a user records four minutes and
  is told at the end that it cannot be a GIF.
- **An independent GIF recorder** with its own pacing and palette strategy.
  Better GIFs, and a second copy of every hard part of a session.
- **Event-driven WASAPI** (`SetEventHandle`). The usual advice, and wrong here:
  a loopback client fires no events while nothing is playing, so a session
  recording a silent desktop would block forever.
- **A global GIF palette.** See above — correct, and unaffordable at the
  duration ceiling.

## Consequences

- Record and GIF are live on the Home launcher (`Mod+3` / `Mod+4`) and record
  the monitor under the cursor. The capture window has a **Record screen**
  (`nav === "record"`) mirroring the Capture screen: target tiles, format
  tiles, options, footer, same Space trigger.
- **Region and window recording go through the overlay**, via two new
  `OverlayMode`s — `RecordRegion` (reuses Region's whole drag interaction) and
  `RecordWindow` (reuses Window's hover-and-click). They diverge from their
  capture counterparts only at commit, where the rect starts a recorder session
  instead of cropping the snapshot. Neither fires the capture flash: nothing was
  captured, and flashing would claim a still had been taken.
- **The chosen format reaches the overlay through a frontend-to-frontend mirror
  event** (`clippity://overlay/record-format`), the same mechanism the scroll
  direction already uses. The overlay is a separate window and cannot see the
  Record screen's selection; without the mirror every overlay-started recording
  would silently be an MP4.
- **One request builder, four entry points.** `shared/lib/recorderRequest.ts` is
  the only place a `RecorderRequest` is assembled — Home's two cards, the Record
  screen, the overlay's region finalize and its window click all go through it,
  so the same settings cannot mean different things depending on which button
  the user pressed.
- Audio is user-controllable through a `RecordingSettings` section and a
  Settings → Recording panel. **Both inputs ship off**: a recorder that starts
  listening to the room, or captures whatever music is playing, the first time
  someone tries it is a privacy surprise rather than a convenience.
- **A `recorder-frame` window outlines the recorded area** for the length of
  the session (`recording.outline`, **on** by default). Once the overlay is
  down nothing else on screen says what is being recorded — the HUD sits in a
  corner and the region has no other marker. It is click-through
  (`set_ignore_cursor_events`, because the user is working *inside* that
  rectangle) and listed in `SHIELDED_WINDOWS`, so it never lands in the file.
  `domain::recorder::outline_frame` grows the rect outward by `OUTLINE_PX` so
  the ring frames the pixels instead of covering their edge, and **clips**
  rather than shifts at a screen edge — an indicator that lies about the bounds
  is worse than one that is cut off.
- **`RecordingSettingsSource`** joins the settings-source traits, so recording
  preferences reach the service for *every* entry point — launcher, Record
  screen, overlay, and any future hotkey or preset — instead of only the ones
  that remember to send them over IPC.
- **Starting a recording from the overlay dismisses it**, via
  `OverlayService::dismiss` — `cancel` split so the overlay comes down without
  the capture window coming back up over the screen about to be recorded. The
  hidden window's label rides on the session and is restored on stop. A
  launcher-started session carries `None`: `restore_window` shows *and* focuses
  its target, so a blanket restore would open a window the user never had up.
- The recorder HUD is sticky and not user-dismissible by timeout — it is the
  only way to stop a session, so a duration that dismissed it would strand a
  recording with no way to end it.
- `AppError::Recorder` joins the error enum with code `"recorder"`, separate
  from `"capture"` because the UI branches on it: a failed screenshot can be
  retaken, a failed recording has to explain what happened to the partial file.
- **The pipeline is verified against real hardware, not just compiled.** Four
  `#[ignore]`d tests do the things that compile perfectly and fail at runtime —
  media-type negotiation, endpoint enumeration, a live loopback drain, and a
  full desktop recording through the real encoder. Run them after touching any
  unsafe or media-type code:
  `cargo test -p clippity-platform -- --ignored` and
  `cargo test -p clippity-services -- --ignored`.
- Not attempted, and deliberately not faked: **cursor and click effects**
  (`RecorderToggles` carries them and the capture path ignores them),
  **webcam overlay**, **trim**, and **WebM** — all C2 in the roadmap.
