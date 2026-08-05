# 0034 — Recorder sources composite over the captured frame, in place and rect-bounded

- **Status:** Accepted (4a implemented; 4b deferred)
- **Date:** 2026-08-05
- **Area:** `app/backend/crates/domain/src/composition.rs` (new),
  `app/backend/crates/platform/src/windows/webcam.rs` (new),
  `app/backend/crates/services/src/recorder_service.rs`,
  `app/backend/crates/services/src/recorder_service/compositor.rs` (new),
  `app/backend/crates/domain/src/{recorder.rs,settings.rs}`,
  `app/backend/src-tauri/src/app/commands.rs` (`list_webcams`),
  `app/shared/src/contracts/{recorder.ts,settings.ts,composition.ts}`,
  `app/frontend/src/features/settings/components/SourcesCard.tsx`
- **Relates to:**
  [0031 — recording is Media Foundation, one session two outputs](0031-recording-is-media-foundation-one-session-two-outputs.md)
  (whose frame loop, held-frame rule and `SinkFrame` view this extends, and
  whose "webcam overlay — not attempted" line this closes),
  [0032 — Studio streams and re-encodes](0032-studio-is-a-separate-surface-that-streams-and-re-encodes.md)
  (whose `IMFSourceReader` decode loop the webcam capture is shaped after),
  [capture roadmap](../roadmaps/capture.md) **C2** (webcam overlay)

## Context

ADR 0031 listed **webcam overlay** among the things it deliberately did not
fake. Everything since — the resolution cap, the audio mixer, encoder settings,
recording presets — has made a recording more configurable without changing
what is *in* the frame. It is still exactly one rectangle of one desktop.

OBS's answer is sources: a scene is an ordered list of things composited into
one canvas. Adopting that wholesale would be the wrong shape for a capture
tool, but the narrow version — put my face and my logo in the corner — is the
single most-requested thing a screen recorder does that Clippity cannot.

Three questions had to be answered before any of it could be written, and one
of them only became visible after reading the frame loop as it now stands.

**Where does compositing happen, and what does it cost?** The recorder's budget
is a whole frame every 16 ms at 60 fps. At 5120×1440 a frame is 28 MiB; ADR
0031's `SinkFrame` exists specifically so that a frame reaches the encoder
*without* a full pass over it, after the old `RgbaImage` conversion was measured
as 28 MiB read and 28 MiB written for a channel rearrangement the encoder does
for free. Any compositing design that reintroduces a per-frame full-canvas pass
gives that back.

**How does a webcam's pixels arrive?** Nothing in the tree opens a camera.

**What happens on a motionless screen?** This is the question that reshaped the
design. The frame loop does not write a frame per tick: an unchanged screen
produces no grab at all, and the *held* frame is re-written in place every
`MAX_HELD_MS` so the fragmented container keeps committing (ADR 0031). The same
buffer, written repeatedly.

## Decision

**Sources composite over the captured frame; they do not build a canvas.** The
recording's geometry stays exactly what it is today — the region, the window,
the monitor the user picked. A source is drawn *into* that rectangle at a
normalized position. This is the difference between a capture tool that can put
a webcam in the corner and a compositor that happens to capture: the second one
needs a canvas size that is nobody's screen, a letterboxing policy, and a
preview surface to arrange it on before anything can be recorded at all.

**Blend in place, into the owned capture buffer.** `Captured` already owns a
`Vec<u8>` that is recycled between frames, and `SinkFrame` is a borrowed view
over it. Compositing writes into that buffer before the view is taken, so the
steady state still allocates nothing and the encoder path is untouched.

**Cost is bounded by overlay area, not canvas area** — the property that makes
this affordable. A 320×240 picture-in-picture is ~77 k pixels blended into a
frame of 7.4 M; the full-canvas pass ADR 0031 removed is not coming back. It
also means the design degrades in the right direction: a user who drags the
webcam to fill the screen pays for what they asked for.

**Each source keeps a backdrop of the pixels it covers, and restores before
every blend.** This is the held-frame consequence, and the reason in-place
compositing is not simply "blend and forget":

- The held buffer is re-written every `MAX_HELD_MS`. A webcam blended once and
  left would **freeze** while the screen was still, which is the opposite of
  what a webcam is for — the face is the part still moving when the screen is
  not.
- Worse, blending a semi-transparent source over its own previous output
  compounds: each re-write darkens it, so a long motionless stretch would fade
  the overlay into a smear.

Restoring the covered pixels first makes each blend idempotent with respect to
the capture underneath it. The backdrop is the size of the overlay, so the extra
copy is bounded the same way the blend is.

**Channel order is resolved per source delivery, not per recorded frame.** A
source's pixels are converted to the capture's `PixelOrder` when they arrive —
once for a still image, once per *camera* frame — rather than on the way into
each recorded frame. Same argument `SinkFrame` makes for the encoder path,
applied one layer up: a 30 fps camera into a 60 fps recording then pays half as
often as a per-recorded-frame swap would, and a camera whose order already
matches pays nothing. The blend is a straight alpha composite over bytes in
matching order, which is why it needs no `PixelOrder` of its own.

**And the capture's order is not fixed for a session** — the wrinkle that only
surfaced against the real frame loop. `FrameSource` can fall back from a held
Desktop Duplication (BGRA) to per-call grabs (RGBA) partway through a recording:
a resolution change, a full-screen app, a lock screen. A source aligned once at
open would swap red and blue from that moment on. So the order travels with each
frame, the compositor compares it against what its sources are aligned to, and
re-aligns on the rare occasion it differs. The camera threads read the wanted
order from a shared atomic, so a change costs no restart.

**Webcam capture is `IMFSourceReader` over a video-capture device** —
`MFEnumDeviceSources` with `MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP`, then
`MFCreateSourceReaderFromMediaSource`. `media_reader.rs` already runs an
`IMFSourceReader` read loop for file decode (ADR 0032), so this is that shape
with a different source, and it costs the installer nothing — the same argument
ADR 0031 made for choosing Media Foundation over a bundled FFmpeg.

**The webcam runs on its own thread and the compositor reads its latest frame.**
A camera's cadence is its own — 30 fps regardless of what the recording is
doing — and blocking the frame loop on a camera read would couple the
recording's frame rate to the camera's. The compositor takes whatever the last
delivered camera frame is; a camera that stalls leaves the previous image up
rather than stalling the recording.

**A source that fails degrades to not being drawn.** A camera in use by another
app, an image file the user has since deleted, a device unplugged mid-session:
none of them may end a recording. This is the same rule ADR 0031 set for audio —
the screen content is what the user came for — and it is why sources are opened
before the session starts but never gate it.

### Staged

**4a — overlay sources, CPU, in this ADR.** Webcam and image sources, blended
per above. This is the useful 80 % and it does not touch the D3D path.

**4b — multi-screen compositing, deferred.** Two monitors side by side in one
frame is a different problem: cost scales with canvas area, CPU blending will
not hold 60 fps, and it needs the canvas-size and letterboxing policy this ADR
avoids. `MonitorDuplicator` already owns an `ID3D11Device`/`ID3D11DeviceContext`
and Media Foundation takes a D3D manager, so the GPU path is reachable — but it
is a rewrite of the frame path rather than an addition to it. Revisit when 4a is
in use and the demand is real.

### Rejected

- **A canvas the sources sit on, OBS-style.** The honest version of scenes, and
  the wrong trade here: it makes every recording answer "what size is the
  canvas" before it can start, and turns the region the user dragged into
  content to be letterboxed inside something else. Clippity's recordings are of
  a thing on screen; the frame is that thing's size.
- **Compositing into a scratch canvas each frame.** Simpler — no backdrop
  bookkeeping, no restore — and it costs a full-canvas copy per written frame,
  which is precisely the 28 MiB pass `SinkFrame` was introduced to delete.
- **Compositing at the sink, after the resolution cap.** Tempting, because the
  capped frame is smaller and the blend would be cheaper. Rejected because the
  overlay would then be scaled by the cap: a webcam composited at 1080p and one
  composited at source and then downscaled are different pictures, and the
  second is the one the user positioned.
- **Blending on the GPU for 4a.** The device is right there in
  `MonitorDuplicator`. But the frame is already in CPU memory by the time the
  compositor sees it (the duplication path copies it out), so a GPU blend would
  mean uploading 28 MiB to save work on 77 k pixels.
- **Driving the webcam from the frame loop.** One less thread, and it makes the
  recording's frame rate a function of the camera's — a 15 fps webcam would cap
  a 60 fps recording.
- **Compositing in Studio instead, after the fact.** Would make the overlay
  re-positionable forever, which is genuinely nicer. It also requires the webcam
  to have been recorded as a second stream, which is a bigger change to the
  container and the session than the thing it enables.

## Consequences

- `domain::composition` owns the pure shape: an ordered `Vec<Source>`, each a
  `kind` + a `NormRect` + an opacity. `NormRect` is
  `domain::annotation`'s, reused rather than re-declared — it already resolves
  against a frame size with a tested `to_pixels`, and a second normalized rect
  in the same crate would be two things to keep in agreement.
- Ordering is explicit and last-wins, so two overlapping sources have a defined
  result rather than one that depends on iteration order.
- The blend is a pure function over byte slices in `domain`, unit-tested against
  known inputs — which is what makes "does alpha work" answerable without a
  camera or a recording.
- `RecorderRequest` carries the source list, so it reaches every entry point
  through the one request builder, and a **recording preset can store it** (ADR
  0031's preset decision) — which is what makes "my streaming setup" and "my
  silent demo" two presets rather than two rounds of re-configuring.
- Sources are configured in **Settings → Recording**, beside the audio devices
  and for the same reason: they are a standing preference, not a per-session
  one. Position is a **corner preset**, not a drag surface — free positioning
  wants a live preview of the frame to drag on, and a recording's frame is
  whatever the user is about to point at, which does not exist while the panel
  is open. Because the rect is normalized, a corner lands correctly on any
  region or monitor.
- A `#[ignore]`d integration test opens a real camera, for the same reason ADR
  0031's four exist: enumeration and media-type negotiation are what compile
  perfectly and fail at runtime.
