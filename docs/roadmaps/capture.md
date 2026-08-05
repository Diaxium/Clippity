# Capture and recording roadmap

This product-area roadmap connects [features](features.md),
[screens](screens-navigation.md), [UX](ux.md), [performance](performance.md),
[security](security-privacy.md), [accessibility](accessibility.md) and
[testing](testing.md).

## Current state and strengths

Region, window and fullscreen capture are production-shaped. Custom modes
include object detection, multi-area, clipboard, scrolling, panoramic, OCR,
color and palette capture. Region selection includes rectangle, freehand,
pen/Bézier, magnetic lasso and brush. Cursor, clipboard, delay, enhancement,
editor preview, provenance and last-region repeat are implemented. The overlay
is Clippity's strongest interaction surface and should remain fast and focused.

Playback and trim landed 2026-08-02 ([ADR 0032](../decisions/0032-studio-is-a-separate-surface-that-streams-and-re-encodes.md)):
recordings open in **Studio**, a dashboard view beside the annotation
editor, with scrubbing, frame stepping, in/out handles and export to MP4
or GIF. A trim decodes and re-encodes through the recorder's existing
sinks, so the cut lands on the frame the handles showed rather than on
the nearest keyframe.

Screen recording landed 2026-07-25 ([ADR 0031](../decisions/0031-recording-is-media-foundation-one-session-two-outputs.md)):
Media Foundation H.264/AAC MP4 and streaming GIF from one capture
session, with a pause/stop HUD, crash-safe fragmented output, and
WASAPI microphone + system-loopback capture. Fullscreen, region and
window targets all record, from the Home launcher or the capture
window's Record screen, with audio and frame rate under Settings →
Recording.

## Gaps and opportunities
- Change Detection and Asset Extract are visible but unavailable.
- Capture hub and overlay cannot switch modes symmetrically.
- No per-app exclusion, ephemeral capture, import/open-with or durable result
  history exists.
- Presets cover only still capture types and a few toggles.

## Delivery portfolio

| Phase | Initiative | Priority | Impact | Complexity | Prerequisites |
| --- | --- | --- | --- | --- | --- |
| C0: polish (0–8 wk) | Canonical result event/actions; import; consistent mode switch; repeat-region in hub; permission/disk/model recovery; honest unavailable UI. | P0/P1 | High | L | Result contract, UX3, security foundations. |
| C1: recorder beta (2–4 mo) | ~~Region/window/fullscreen video + GIF, mic/system audio, pause/stop, crash-safe partial file~~ **done**; ~~trim~~ **done** ([ADR 0032](../decisions/0032-studio-is-a-separate-surface-that-streams-and-re-encodes.md)); remaining: cursor/click effects, WebM. | P1 | Transformative | XL | Media job service, recorder screens, native fixtures. |
| C2: recorder finish (4–6 mo) | GIF optimization, webcam overlay, annotations during recording, hotkey customization, presets and performance profiles. | P2 | High | XL | C1 telemetry and editor/media renderer. |
| C3: intelligent capture (6–12 mo) | Change Detection, Asset Extract, sensitive-data detection/redaction and Live Lens. | P2/P3 | High | XL | Vision integrity, search/library schema. |
| C4: automation (9–18 mo) | Scheduled visual monitors, CLI/URI triggers and recipe capture steps. | P2/P3 | Transformative | XL | Recipe/security/scheduler architecture. |

## Implementation phases

1. Specify one `CaptureArtifact` result for image, video, GIF, color, palette and
   text, including source, destination, warnings and reversible actions.
2. Build deterministic native capture/audio providers and permission-denial
   fixtures before recorder UI.
3. Stream media with bounded queues, cancellation and recoverable temporary
   output; never hold an entire recording in memory.
4. Add keyboard/screen-reader operation, progress announcements and privacy
   controls alongside each mode.
5. Cohort beta on a hardware/app matrix, then promote formats and features by
   measured success.

## Success criteria

- Still capture success ≥99.5%; warm overlay p95 <250 ms; saved result p95 <1.5
  seconds for 4K.
- Recorder success ≥99%; no recoverable session loses all media; A/V drift <100
  ms over 30 minutes; dropped-frame rate <1% on reference hardware.
- Users always know save/copy/editor destination and can undo/delete the latest
  result.
- All capture modes keyboard-completable or have a documented equivalent path.

## Risks and alternatives

- System-audio capture is platform-specific; publish a capability matrix and
  ship mic-only where necessary rather than simulating parity.
- Intelligent modes can delay the overlay; run optional analysis after snapshot
  and preserve immediate rectangle capture.
- Scheduled monitoring is privacy-sensitive; keep it local, explicit, paused on
  lock/battery policies and visible in the tray.

