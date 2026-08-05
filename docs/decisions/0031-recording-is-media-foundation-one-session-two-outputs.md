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
- **Output resolution is a height cap applied in the encoder, not in Rust.**
  `RecordingSettings::max_height` (default `0` = the captured size) caps the
  encoded frame's height; `domain::recorder::scale_to_max_height` preserves the
  aspect ratio, rounds even, and **never upscales**. Deliberately a height cap
  rather than the area budget `gif_target_size` argues for a few lines above:
  GIF's budget is a promise about *file size*, and area is what file size
  tracks, but "1080p" is a promise about *vertical resolution* — capping an
  ultrawide session there has to mean 3840×1080, not a letterbox with a 16:9
  clip's pixel count. The two compose, tighter one winning
  (`recorder::output_size`), so the setting is one value for both formats
  instead of the split the frame rates need.

  The scaling itself is Media Foundation's: `Mp4Config` carries the capture
  size as `source_*` alongside the encoded size, and declaring an input media
  type that differs from the output is what makes the sink writer load its
  Video Processor MFT. A CPU resize per frame — the obvious implementation, and
  what `gif_sink` does at a quarter the resolution and half the rate — does not
  fit in a 60 fps budget at 4K, so the setting meant to make recording cheaper
  would have made it drop frames. `Mp4Writer::input_size` reports what was
  actually negotiated and `mp4_sink` resizes only if the processor was
  unavailable, so a machine without one honours the setting slowly instead of
  failing when Record was pressed.

  `RecorderResult` now reports the **encoded** size rather than the region's.
  It always should have — a downscaled GIF has been misreporting its dimensions
  to the library since C1 — and a resolution cap makes the gap routine rather
  than an edge case.
- **Audio is a two-channel mixer, not two switches.** `AudioSelection` carries a
  per-source gain and `AudioMixer::pump` applies it **pre-mix**, which is the
  only place it can do what a mixer is for — scaling the sum would move both
  inputs together and could not fix the imbalance that motivates the control
  (a headset mic sits well below the system mix on most machines, and the two
  are muxed into one AAC stream, so it is unfixable afterwards).

  **Gain is an integer percentage, not a float multiplier.** It is the unit the
  slider shows, it round-trips through JSON exactly, it keeps `AudioSelection`
  `Eq` — which `ValidatedRecorderRequest` and its tests rely on — and there is
  no NaN to defend against. Read-clamped by `clamp_gain_pct` on the same
  contract as `clamp_fps` and `clamp_max_height`. The ceiling is +6 dB because
  the mix is clamped to full scale on the way to 16-bit PCM, so past that a
  bigger number buys distortion rather than volume.

  **Mute is gain zero plus a remembered level, and lives only on the session.**
  Storing it would make "I muted once" outlive the recording it was for; a
  muted source still keeps its endpoint open, so unmuting is instant and the
  meter keeps reading, which is the difference between a mute button and a
  toggle. `SessionControl` holds both the live and the pre-mute value in
  atomics, so a slider drag never blocks on a worker inside a blocking encoder
  call.

  **The persisted level is a starting level.** Settings → Recording sets what a
  session begins at; the HUD's sliders move the running session and deliberately
  do not write back, so a level nudged for one awkward recording does not become
  the level every future one starts at.

  **Meters get their own event.** `clippity://recorder/levels` carries peak (not
  RMS — "is this live" and "is it clipping" are both peak questions) at 10 Hz,
  scoped to the toast window. Folding it into `recorder/tick` would have meant
  raising a 2 Hz payload of elapsed time, frame counts and file size to meter
  rate, making every existing reader pay for the meters. A session with no audio
  emits it not at all. The mixer *holds* peaks between emits rather than
  sampling at emit time — audio is polled ten times more often than the meters
  are sent, and a meter that misses the loud part is worse than no meter.

  `ToastPayload::Recorder`'s `audio: bool` became `microphone` + `system`: the
  HUD draws one row per live source and one boolean cannot say which. It is now
  also gated on `RecorderFormat::supports_audio`, so a GIF session cannot show a
  microphone row for a track `validate` has already emptied.
- **The encoder is configurable, through named steps rather than a bitrate box.**
  `RecorderEncoding` groups quality, an optional fixed bitrate, keyframe
  interval, rate control and the hardware preference — grouped for the same
  reason `AudioSelection` and `RecorderToggles` are: they are read together,
  defaulted together, and only the MP4 path has any use for them.

  **Quality is a bits-per-pixel multiplier, not a number the user types.** The
  right bitrate depends on frame size and rate — the same 8 Mbps that is
  generous for a 720p region starves a 4K desktop — so a typed number is only
  meaningful for the one recording it was typed for. `Balanced` is the previous
  fixed 0.07 bpp exactly, so choosing it changes nothing. The fixed-bitrate
  override remains for the case where something downstream needs a known
  number, and is clamped by the same floor and ceiling as a derived value:
  those bounds do not stop applying because somebody typed it.

  **Variable rate control is now the default, and that is a behaviour change.**
  Before this the code declared only `MF_MT_AVG_BITRATE` and let the MFT pick,
  which is constant-rate on every encoder we have seen — so a recording of a
  motionless desktop spent full bitrate padding frames where nothing happened.
  Screen capture is the definitional case for VBR. `UnconstrainedVBR` rather
  than a peak-constrained mode, because a peak constraint gives back exactly
  the saving this is for.

  **Rate control is best-effort; everything else is negotiated.** Keyframe
  spacing (`MF_MT_MAX_KEYFRAME_SPACING`) and the hardware preference are a
  media-type attribute and an attribute-store value, so a machine that dislikes
  either fails loudly at negotiation. Rate control is not — it lives on the
  encoder's `ICodecAPI`, reached through `GetServiceForStream`, and not every
  encoder exposes one. That path logs and continues: the file is still correct
  at the declared average bitrate, and refusing to record over a tuning
  preference would be the wrong trade. Same degradation shape as the resolution
  cap's missing video processor.

  **Keyframe interval is stored in seconds and used in frames.** It is not
  cosmetic — a decoder can only start at a keyframe, so the interval *is* the
  granularity Studio's scrubber can seek to, and left unset the encoders pick
  wildly different values. Storing seconds means changing the frame rate does
  not silently change how finely a recording can be seeked.

  A fifth `#[ignore]`d integration test covers what compiles and then fails at
  runtime: five settings combinations negotiated against the real encoders,
  including forced *software* encoding — the one path a GPU-equipped machine
  otherwise never exercises.
- **A recording is a preset, not a "scene".** OBS calls a saved, switchable
  capture configuration a scene. This codebase already had that concept and
  called it a preset — `CapturePreset` only ever held a `CaptureRequest`
  because the recorder was built afterwards. A parallel "scenes" surface would
  have meant two managers, two editors, two run paths and two places to look
  for the same idea, so `PresetRequest` became a two-variant union instead and
  the existing manager grew a mode switch.

  **The union is untagged, and that is the migration.** Presets already on disk
  are bare `CaptureRequest` objects with no discriminant; an internally-tagged
  enum would refuse every one of them. Untagged is safe here because the two
  shapes are **disjoint by required field** — a capture must carry `type` and
  `toggles`, a recording must carry `target` and `format`, and neither has a
  serde default — so a payload can satisfy at most one variant and the
  declaration order carries no meaning. Two tests assert that disjointness in
  both directions, because it is a property of *other* structs: if a future
  refactor defaults one of those four fields, the guarantee quietly disappears
  and those tests are what notices.

  **A recording preset mirrors its whole request to the overlay, not just its
  format.** Region and Window recordings finalize in the overlay, which is a
  separate window that rebuilds the request from the live settings store — so a
  preset's frame rate, resolution, audio and encoder settings would have been
  silently discarded for two of the three targets, which is worse than not
  supporting them. `clippity://overlay/record-preset` carries the request; both
  finalize paths resolve it through one helper (`overlayRecorderRequest`), for
  the same reason all four entry points share one request builder.

  The mirror is emitted on **every** overlay open, `null` included. The overlay
  keeps whatever it was last told, so an unsent null would make the next
  ordinary region recording quietly inherit the last preset's configuration —
  a leak with no visible cause. There is a test for exactly that.

  **What a recording preset does not store:** audio gains and encoder settings.
  Those are tuning for a machine, not for a workflow; duplicating them per
  preset would mean a user who fixes their mic level once has to fix it again
  everywhere. `openEditor` is dropped rather than stored-and-ignored, because
  the editor cannot open a video at all.

  **Per-preset global hotkeys are not part of this.** Shortcuts today are one
  `global_capture` binding plus static in-app registries keyed by fixed ids;
  binding *a* preset needs dynamically registered, user-data-keyed shortcuts
  with their own conflict handling. That is a feature, not a follow-on, and
  pretending otherwise would have meant a half-built one.
- Not attempted, and deliberately not faked: **cursor and click effects**
  (`RecorderToggles` carries them and the capture path ignores them),
  **webcam overlay**, **trim**, and **WebM** — all C2 in the roadmap.
