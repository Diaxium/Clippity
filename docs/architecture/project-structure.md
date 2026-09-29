# Project structure

Clippity is a single **root-level workspace**: one pnpm workspace and one
Cargo workspace, both driven from the repository root (see
[ADR 0030](../decisions/0030-root-workspace-restructure.md)).

```text
Clippity/
├── package.json              # root scripts + shared dev tooling
├── pnpm-workspace.yaml       # JS package list + native-build approvals
├── pnpm-lock.yaml            # the one lockfile
├── app/
│   ├── frontend/             # pkg: clippity-frontend  (React 19 + Vite 8 + Tailwind v4)
│   ├── shared/               # pkg: @clippity/shared   (IPC wire contracts, type-only)
│   └── backend/              # Cargo workspace
│       ├── Cargo.toml        # [workspace]: shared deps + release profile
│       ├── Cargo.lock
│       ├── benches-budgets.json  # warn/fail bands for `pnpm bench:check`
│       ├── crates/
│       │   ├── infra/        # clippity-infra     errors, logging, paths, config, events
│       │   ├── domain/       # clippity-domain    pure types + rules (no I/O, no Tauri)
│       │   ├── platform/     # clippity-platform  Win32 (DWM, capture, Media Foundation, input)
│       │   ├── vision/       # clippity-vision    ONNX object detection + model download
│       │   ├── services/     # clippity-services  capture / recorder / library / editor / …
│       │   └── bench/        # clippity-bench     Criterion benchmarks + synthetic corpora
│       └── src-tauri/        # pkg: clippity-tauri  the app crate + tauri.conf.json
├── docs/
├── installer/                # standalone installer workspace (consumes the build output)
├── scripts/                  # build collection, portable/payload/release staging, bench gate
└── build/                    # generated: collected artifacts (git-ignored)
```

## JavaScript packages

| Package | Path | Role |
| --- | --- | --- |
| `clippity-frontend` | `app/frontend` | The React app: every Tauri window's UI. |
| `@clippity/shared` | `app/shared` | Framework-agnostic IPC **contracts** (types only), consumed by the frontend via `workspace:*`. |
| `clippity-tauri` | `app/backend/src-tauri` | Thin wrapper that owns the Tauri CLI + `tauri.conf.json`. |

Only these three are root-workspace packages; they are listed in
[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml). The installer under
`installer/` is a separate pnpm workspace with its own lockfile; see
[installer/README.md](../../installer/README.md).

## Rust crates

A strict, one-directional dependency DAG. Each crate may depend only on the
crates listed beside it:

| Crate | Depends on (internal) |
| --- | --- |
| `clippity-infra` | - |
| `clippity-domain` | infra |
| `clippity-platform` | domain, infra |
| `clippity-vision` | domain, infra |
| `clippity-services` | platform, domain, infra |
| `clippity` (`src-tauri`) | services, vision, platform, domain, infra |
| `clippity-bench` | services, platform, domain |

- **infra** depends on nothing internal (it may use `tauri` for the error
  type + path resolver + the outbound event channel).
- **domain** is pure: `serde` + `image` math only; no Tauri, no I/O.
- **platform** holds OS-specific code (`windows` crate, `cfg`-gated).
- **vision** isolates the heavy ONNX toolchain (`ort`, `ndarray`) so it
  compiles in parallel and caches independently. Nothing below the app crate
  depends on it.
- **services** perform I/O and are wired into `AppState` at the app layer.
- **src-tauri** is the Tauri binary + library: command handlers, `AppState`,
  window creation, and the system-tray composition.
- **bench** is dev-only; see [perf/benchmarks.md](../perf/benchmarks.md).

Why crates instead of modules: independent compilation units build in
parallel and cache separately, so an app-layer edit doesn't recompile the
slow leaves (`ort`, bundled SQLite, the `windows` crate). See
[development/performance.md](../development/performance.md).
