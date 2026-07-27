# Concepts

The vocabulary Clippity uses, and the ideas behind the main flows.

## Capture

A **capture** is a saved screen grab. It has a **type** (region, window,
fullscreen) or a **custom mode** (freehand, multi-area, color-picker, palette,
grab-text/OCR, scrolling-window, panoramic, …). Toggles — preview-in-editor,
copy-to-clipboard, include-cursor, smart-enhance — ride with the request.

## Overlay

The transparent full-screen surface used to select a region. It snapshots the
virtual desktop, lets the user drag/draw a selection, and finalizes into a
capture. Selection methods (rectangle, freehand, brush, …) share one cached
snapshot.

## Library, aux catalog, and provenance

The **library** is the inventory of captures. File-backed entries
(image/video/gif) are files in the captures directory; **aux** entries
(color/palette/text) have no file and live in an aux catalog. Each capture
carries **provenance** — the app/window it came from, the mode, the monitor,
the time — written to a `.meta` sidecar at the save choke point.

## Labels vs collections

- **Labels** (tags + a favorite flag) are properties *of* a capture and ride
  in a `.labels` sidecar beside it.
- A **collection** is a named, manually ordered *set* of captures — it has its
  own name and order that no per-capture record can express, so it is its own
  document (`collections.json`). See
  [ADR 0029](../decisions/0029-labels-are-a-sidecar-collections-are-a-document.md).

## Editor

A layered, non-destructive annotation editor. It loads a capture as a data
URI, edits an editable scene, and saves either a flattened PNG or the editable
scene as a sidecar. Annotation types are opaque to the backend (baked into
pixels on save).

## Presets

A saved capture configuration (a `CaptureRequest` + output steps). Running a
preset dispatches the ordinary capture commands, stamping the preset's name
into the capture's provenance.

## Vision & models

On-device AI (ONNX via `ort`) powers Object mode. Models are downloaded and
managed through the Models settings; the `clippity-vision` crate handles
inference and downloads.
