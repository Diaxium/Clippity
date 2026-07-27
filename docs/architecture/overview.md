# Architecture overview

Clippity pairs a fast, animated React UI with a native Rust core over
[Tauri v2](https://tauri.app). Capture, window detection, OCR, and image
processing run at native speed while the interface stays light.

## Multi-window by design

The app is a set of dedicated Tauri windows, each with its own React entry
rendered from a single HTML file via hash routing:

| Window | Route | Purpose |
| --- | --- | --- |
| Capture | `index.html` | The capture hub (shown at launch). |
| Main / Dashboard | `#/main` | Library, Editor, Settings, Presets. |
| Overlay | `#/overlay` | Transparent full-screen region selection. |
| Toast | `#/toast` | Transient capture-confirmation notifications. |
| Tray | `#/tray` | Left-click flyout panel of recent captures. |
| Countdown | `#/countdown` | Pre-capture timer strip. |

All windows are created up front in the backend (see
[`src-tauri/src/lib.rs`](../../app/backend/src-tauri/src/lib.rs)
`create_app_windows`) so each can pin its WebView2 data directory and so the
app can hide-to-tray without destroying window state.

## The two halves

- **Frontend** ([architecture/frontend.md](frontend.md)) — React 19,
  TypeScript, Vite 7, Tailwind v4, Zustand for state, Motion for animation.
  Feature-organized under `app/frontend/src`.
- **Backend** ([architecture/backend.md](backend.md)) — a Rust Cargo
  workspace of layered crates (`infra → domain → platform/vision →
  services → src-tauri`).

## The seam between them

Every interaction is a typed IPC call or event. The wire shapes are defined
once in [`@clippity/shared`](../../app/shared) and mirrored by the Rust
`domain::*` structs. See [architecture/ipc.md](ipc.md).

## Design decisions

Non-obvious choices are recorded as ADRs in
[decisions/](../decisions/README.md) — e.g. the capture/overlay dispatch
model, provenance sidecars, and the library index as a reconciled cache.
