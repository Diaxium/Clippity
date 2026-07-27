# Project structure

Clippity is a single **root-level workspace** — one pnpm workspace and one
Cargo workspace, both rooted at `restructure/`.

```text
restructure/
├── package.json              # root scripts + shared dev tooling
├── pnpm-workspace.yaml        # JS package list + native-build approvals
├── pnpm-lock.yaml             # the one lockfile
├── node_modules/
├── app/
│   ├── frontend/              # pkg: clippity-frontend  (React 19 + Vite + Tailwind v4)
│   ├── shared/                # pkg: @clippity/shared    (IPC wire contracts, type-only)
│   └── backend/               # Cargo workspace
│       ├── Cargo.toml         # [workspace] — shared deps + release profile
│       ├── Cargo.lock
│       ├── crates/
│       │   ├── infra/         # clippity-infra    errors, logging, paths, config, events
│       │   ├── domain/        # clippity-domain   pure types + rules (no I/O, no Tauri)
│       │   ├── platform/      # clippity-platform Win32 (DWM, OCR callers, enumeration)
│       │   ├── vision/        # clippity-vision   ONNX object detection + model download
│       │   └── services/      # clippity-services capture / library / editor / settings / …
│       └── src-tauri/         # pkg: clippity-tauri  the app crate + tauri.conf.json
├── docs/
└── installer/                 # standalone installer project (consumes the build output)
```

## JavaScript packages

| Package | Path | Role |
| --- | --- | --- |
| `clippity-frontend` | `app/frontend` | The React app — every Tauri window's UI. |
| `@clippity/shared` | `app/shared` | Framework-agnostic IPC **contracts** (types only), consumed by the frontend via `workspace:*`. |
| `clippity-tauri` | `app/backend/src-tauri` | Thin wrapper that owns the Tauri CLI + `tauri.conf.json`. |

Only these three are pnpm packages; they are listed in
[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml).

## Rust crates

A strict, one-directional dependency DAG (top → bottom):

```text
src-tauri (clippity)
   ├── clippity-services ──┐
   ├── clippity-vision ────┤
   │        ├── clippity-platform
   │        │        └── clippity-domain
   │        └── clippity-domain
   │                 └── clippity-infra
   └── (all of the above)
```

- **infra** depends on nothing internal (it may use `tauri` for the error
  type + path resolver + the outbound event channel).
- **domain** is pure — `serde` + `image` math only; no Tauri, no I/O.
- **platform** holds OS-specific code (`windows` crate, `cfg`-gated).
- **vision** isolates the heavy ONNX toolchain (`ort`, `ndarray`) so it
  compiles in parallel and caches independently.
- **services** perform I/O and are wired into `AppState` at the app layer.
- **src-tauri** is the Tauri binary + library: command handlers, `AppState`,
  window creation, and the system-tray composition.

Why crates instead of modules: independent compilation units build in
parallel and cache separately, so an app-layer edit doesn't recompile the
slow leaves (`ort`, bundled SQLite, the `windows` crate). See
[development/performance.md](../development/performance.md).
