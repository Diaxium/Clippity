# 0035 — HDR preservation is an explicit output path

- **Status:** Accepted
- **Date:** 2026-09-08
- **Area:** HDR still capture, desktop duplication, recorder, Media Foundation
- **Relates to:** [0031 — recording is Media Foundation](0031-recording-is-media-foundation-one-session-two-outputs.md)

## Context

Clippity already captured an HDR desktop as FP16 scRGB, but immediately
tone-mapped that signal into an 8-bit SDR image. That fixed washed-out
screenshots while discarding highlight headroom and wide-gamut information.
Recording never entered the FP16 path at all.

An HDR output must preserve both the higher-precision signal and its color
description. Merely placing SDR bytes in a 10- or 16-bit container would be a
mislabeled file, while silently substituting SDR after the user requests HDR
would make failures difficult to detect.

## Decision

HDR is an explicit, opt-in output path.

- Stills convert linear scRGB to 16-bit RGB BT.2020/PQ PNG and write `cICP`,
  `mDCV`, and content-derived `cLLI` chunks.
- MP4 recording keeps desktop duplication in FP16, converts each frame to
  limited-range P010, and requests HEVC Main10 with BT.2020/PQ Media Foundation
  attributes.
- SDR capture and the existing HDR-to-SDR tone map remain the default
  compatibility path.
- An active HDR capture failure is an error; Clippity does not silently label
  or substitute SDR as preserved HDR.
- HDR rectangles must fit on one display. Cursor compositing, Smart Enhance,
  freehand masks, multi-area stitching, and recorder sources remain on the
  8-bit compositor and therefore cannot be combined with preserved HDR.
- GIF remains SDR. Main10 recording requires a compatible hardware encoder and
  fails clearly when the platform cannot negotiate one.

## Consequences

The two export paths now have honest, testable color contracts. Compatibility
is unchanged by default, while users with an HDR display and decoder can keep
highlight range and wider color. Future work can move individual transforms to
linear FP16 and remove their HDR restrictions without changing the file or IPC
contracts introduced here.
