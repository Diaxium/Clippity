# Prerequisites

- **[Node.js](https://nodejs.org/) 18+**
- **[pnpm](https://pnpm.io/) 11+** — the only supported package manager (a
  single root lockfile; npm/yarn are not used). Enable via
  `corepack enable` or install standalone.
- **[Rust](https://rustup.rs/) 1.78+** (stable toolchain), with `cargo`,
  `rustfmt`, and (for `pnpm lint`) `clippy` components:
  `rustup component add rustfmt clippy`.
- **Tauri v2 system dependencies.** On Windows: Microsoft C++ Build Tools
  and WebView2 (preinstalled on Windows 11). See the
  [Tauri prerequisites guide](https://tauri.app/start/prerequisites/) for
  your OS.

## First-build network access

The first native build needs the network:

- **`ort` (ONNX Runtime)** downloads matching native binaries at build time.
- A **`uv` + Python sidecar** is fetched on first launch to power vision
  features.

## Platform support

Windows is the primary, fully-supported target. Several capture features
(OCR via `Media.Ocr`, window detection, Mica vibrancy) use Windows-specific
APIs; macOS/Linux are Tauri-capable but not yet at feature parity.
