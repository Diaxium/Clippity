# 0027 — The monitor is attributed, the preset is declared

- **Status:** Accepted (implemented)
- **Date:** 2026-07-21
- **Area:** `app/backend/src/domain/{metadata.rs,window_attribution.rs,capture.rs,overlay.rs,library.rs,preset.rs}`,
  `app/backend/src/services/{overlay_service.rs,capture_service.rs,scroll_capture_service.rs,library_service.rs}`,
  `app/backend/src/app/commands.rs`,
  `app/frontend/src/services/tauri/clients/{capture.ts,overlay.ts,presets.ts,library.ts}`,
  `app/frontend/src/features/library/lib/format.ts`
- **Relates to:** [0026 — capture provenance is a sidecar](0026-capture-provenance-is-a-sidecar-written-at-the-save-choke-point.md)
  (this closes the two fields it deliberately left absent),
  [0004 — capture presets](../roadmaps/capture.md) (the preset name travels
  the route `output_dir` already cut),
  [library-organization](../roadmaps/library-organization.md) **Phase 1**

## Context

ADR 0026 shipped the provenance sidecar and named two fields it would not
guess: **which display** a capture came from, and **which preset** produced
it. Both are wanted by [Library P3](../roadmaps/library-organization.md)
filters and P4 smart collections ("everything off the second monitor",
"everything the Bug-report preset took"), and neither could be filled in
by the save choke point as it stood.

They are missing for opposite reasons, and that is the whole decision.

**The monitor is observable but unattributed.** Every pipeline knows the
rectangle it captured; none of them knew which screen that rectangle was
on. A region selection can also straddle two displays, so "which monitor"
is not a lookup — it's the same *attribution* question the window title
already answers.

**The preset is not observable at all.** Presets are executed by the
frontend's `runPreset` orchestrator, which dispatches through the ordinary
capture commands. From the backend, a preset capture and an interactive
capture are byte-identical. No amount of inspection at the save point can
recover the difference.

## Decision

**Monitor: attributed by area, through the module that already attributes
by area.** `domain::window_attribution` gains `dominant_monitor`, a sibling
to `dominant_window` over the same `RectI` primitives, and the same rule —
the display contributing the most pixels wins, so a selection dragged
across a seam records the screen it mostly sits on. It is the *simpler* of
the two: displays partition the desktop instead of stacking on it, so
there is no occlusion pass, just summed intersection area.

The overlay **freezes its display list at `show`**, beside the window list
and for the same reason: by `finalize` the overlay is gone and the desk may
have changed. Producers with no session to inherit from — the scroll
recorder, the one-shot region repeat — call `monitor_for_regions`, which
resolves against the live layout at the one instant each of them has.

The recorded value is `Display 1` / `Display 2` …, derived by the pure
`domain::metadata::monitor_label` from the platform device name
(`\\.\DISPLAY2`). Windows already numbers displays that way, and it is the
number Display Settings shows the user. An unrecognised name is passed
through trimmed rather than reformatted into an ordinal it doesn't have.

**Preset: declared by the only component that knows.** `preset` becomes an
optional field on `CaptureRequest` and `BeginOverlayRequest` — an **IPC
field, not a metadata field** — filled in by `runPreset` at dispatch. It
rides the exact route `output_dir` cut for the same reason (ADR 0004): for
the overlay it is stashed on the session at `show` and consumed at
`finalize`, because the capture it describes happens several IPC calls
later.

The name is stamped **at dispatch, never stored on `preset.request`**. A
saved request carrying its own name would go stale the moment the user
renamed the preset, and would then be recorded as truth.

**`persist_and_emit` now takes the `CaptureSource` itself** instead of a
widening list of loose provenance arguments (title, app, label, and now
monitor, preset). It fills in only the pixel dimensions, which are the one
field that cannot exist before the image does. The struct ADR 0026 already
built to keep naming and metadata in agreement turns out to be the right
parameter as well — and it means the next provenance field is not another
argument every call site has to thread.

### Rejected

- **The monitor's marketing name** ("Dell U2720Q"). `friendly_name()` costs
  a `DisplayConfig` round-trip per monitor and yields "Generic PnP Monitor"
  or "Unknown Monitor 65537" often enough to be useless — the same argument
  ADR 0026 used for taking an application's executable stem over its
  version-resource name. The device ordinal is free and is what the user
  sees in Display Settings.
- **Resolving the monitor at `finalize`** rather than freezing it at
  `show`. Cheaper in the sessionless paths, wrong in the overlay: the
  frozen snapshot's coordinate space is the one the crop rect is expressed
  in, and re-enumerating after the overlay closes can answer about a
  desktop that no longer matches those pixels.
- **Listing a display whose device name couldn't be read.** A nameless
  entry can win attribution and then record nothing, which is strictly
  worse than not competing — the next-best display is a true answer.
- **Inferring the preset backend-side** (e.g. matching the request against
  stored presets). Two presets can hold identical requests, and an
  interactive capture can match one by coincidence. It would manufacture
  provenance rather than record it.
- **Recording a monitor for the clipboard-ingest and editor-export paths.**
  Neither came off a display. Absent, per ADR 0026's rule.

## Consequences

- **Library Phase 1's metadata half is complete.** Every field the phase
  named — source app, window title, mode, timestamps, dimensions, monitor,
  preset — is now recorded. What remains in Phase 1 is the index and the
  backfill pass, both of which are caches/improvements over these records
  rather than new data.
- Library rows carry `monitor` and `preset`; `formatProvenance` appends
  both to the card tooltip. Optional as ever — captures taken before this
  list exactly as before.
- `SCHEMA_VERSION` stays at **1**. Both fields are additive and optional,
  which the version's own contract says needs no bump; an older reader
  skips them and a newer reader treats their absence as "not known".
- **The overlay's display list is gathered for every mode**, not just the
  file-producing ones (unlike the window list, which is mode-gated). The
  cost is one already-warm display enumeration on a path that is about to
  grab the whole screen, and it is how the next file-producing mode ships
  with a display recorded instead of without one.
- `overlay_service`'s private `MonitorRect` was renamed `MonitorBounds`.
  It models something genuinely different — the raw bounds
  Fullscreen-from-the-overlay crops to — and the collision with the new
  attribution type is the sort that should be resolved by naming the two
  things differently, not by aliasing an import.
- Not recorded, and still deliberately: a preset for the **scroll /
  panoramic** recorder and the **clipboard** mode. Presets don't target
  those flows today (`runPreset` dispatches fullscreen / region / window
  only), so there is no name to pass; when Presets v2 widens that, the
  field is already on the request.
