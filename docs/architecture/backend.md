# Backend

The backend is a **Cargo workspace** at
[`app/backend`](../../app/backend) — a set of layered crates rather than one
crate. The layer boundaries mirror the module structure the app grew up with;
promoting them to crates gives independent, parallel, separately-cached
compilation.

## Crates and their responsibilities

| Crate | Path | Responsibility | Notable deps |
| --- | --- | --- | --- |
| `clippity-infra` | `crates/infra` | Errors, logging, app paths, config, the outbound event channel. | tauri, thiserror, tracing |
| `clippity-domain` | `crates/domain` | Pure types + rules — no I/O, no Tauri. Unit-testable in isolation. | serde, image |
| `clippity-platform` | `crates/platform` | OS-specific code (Win32: DWM chrome, cursor/window enumeration). `cfg`-gated. | windows, window-vibrancy, xcap |
| `clippity-vision` | `crates/vision` | ONNX object detection + model download/registry. | ort, ndarray, ureq |
| `clippity-services` | `crates/services` | Everything that touches the outside world — capture, overlay, library (+ SQLite index), editor, settings, toast, OCR, sharing, scrolling capture. | xcap, image, arboard, rusqlite, base64 |
| `clippity` (`src-tauri`) | `src-tauri` | The Tauri binary + `clippity_lib`: command handlers, `AppState`, window creation, tray composition. | tauri (+ plugins) |

## Dependency direction

Strictly top-down (`src-tauri → services/vision → platform → domain → infra`).
There are no upward edges: the event-name constants and `emit` helper live in
`clippity-infra::events` (not the app layer) precisely so services can emit
without depending on the app crate. The one component that legitimately needs
the whole `AppState` — the system tray — lives in the app crate
(`src-tauri/src/tray_service.rs`), not in `clippity-services`.

## Why the split pays off

The slow-compiling dependencies are quarantined:

- **`ort` (ONNX Runtime)** and **`ndarray`** → only `clippity-vision`.
- **bundled SQLite** (`rusqlite`) → only `clippity-services`.
- the large **`windows`** crate → `clippity-platform` + `clippity-services`
  (`cfg`-gated).

An edit to command wiring or `AppState` recompiles only `src-tauri`, leaving
the heavy leaves cached. See
[development/performance.md](../development/performance.md).

## Shared Cargo configuration

Dependency versions, the package version/edition, and the release profile are
declared **once** in the workspace root
[`Cargo.toml`](../../app/backend/Cargo.toml) via `[workspace.dependencies]`,
`[workspace.package]`, and `[profile.release]`; each crate references them with
`{ workspace = true }`.

## Tauri configuration

[`src-tauri/tauri.conf.json`](../../app/backend/src-tauri/tauri.conf.json)
points `frontendDist` at `../../frontend/dist` and drives the frontend
dev/build through pnpm in its `beforeDevCommand` / `beforeBuildCommand`, so
`pnpm tauri:dev` / `pnpm tauri:build` need no manual `cd`.
