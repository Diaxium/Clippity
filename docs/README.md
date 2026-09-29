# Clippity documentation

Clippity is a private, local-first desktop capture, recording, and annotation
app for Windows, built on Tauri v2 (a React 19 + TypeScript frontend over a
Rust Cargo-workspace backend).

Everything is a **root-level workspace**: install, develop, build, test,
and lint all run from the repository root with no `cd` into a package. See
[development/commands.md](development/commands.md).

## Where things live

| Section | What's in it |
| --- | --- |
| [getting-started/](getting-started/) | [Prerequisites](getting-started/prerequisites.md), [installation](getting-started/installation.md), [development](getting-started/development.md), [building and packaging](getting-started/building.md). Start here. |
| [architecture/](architecture/) | How the app is put together: [overview](architecture/overview.md), [frontend](architecture/frontend.md), [backend](architecture/backend.md), [IPC](architecture/ipc.md), [project structure](architecture/project-structure.md). |
| [development/](development/) | Day-to-day: [commands](development/commands.md), [conventions](development/conventions.md), [testing](development/testing.md), [debugging](development/debugging.md), [build performance](development/performance.md). |
| [perf/](perf/benchmarks.md) | The native benchmark harness and its budget gate. |
| [product/](product/) | What Clippity does: [concepts](product/concepts.md), [features](product/features.md). |
| [reference/](reference/) | Keybind references ([editor](reference/editor-keybinds.md), [library](reference/library-keybinds.md)). |
| [decisions/](decisions/README.md) | Architecture Decision Records (ADRs): the "why" behind non-obvious choices. |
| [roadmaps/](roadmaps/README.md) | Per-area roadmaps and the current-state audit. |
| [installer/](installer/README.md) | Design, lifecycle, and test matrix of the Setup / Modify / Update / Uninstall wizard. |
| [releases/](releases/) | Release notes: [v0.3.3](releases/v0.3.3.md), [v0.3.2](releases/v0.3.2.md), [v0.3.1](releases/v0.3.1.md), [v0.3.0](releases/v0.3.0.md). |
| [ux-review/](ux-review/README.md) | Tooling for screenshotting the running app despite its capture shield. |

Historical investigation reports are kept for their evidence and are not
updated as the code moves:
[performance-audit-log](development/performance-audit-log.md) and
[devtools-performance-debug-report](development/devtools-performance-debug-report.md).

## Quick start

```bash
pnpm install        # from the repository root
pnpm tauri:dev      # launch the desktop app
```

New to the codebase? Read [architecture/overview.md](architecture/overview.md),
then [architecture/project-structure.md](architecture/project-structure.md).
