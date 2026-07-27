# Clippity documentation

Clippity is a modern desktop screen-capture, annotation, and
capture-workflow app built on Tauri v2 (React 19 + TypeScript frontend,
a Rust Cargo-workspace backend).

Everything is a **root-level workspace**: install, develop, build, test,
and lint all run from the repository root with no `cd` into a package. See
[development/commands.md](development/commands.md).

## Where things live

| Section | What's in it |
| --- | --- |
| [getting-started/](getting-started/) | Prerequisites, install, first run, building. Start here. |
| [architecture/](architecture/) | How the app is put together — [overview](architecture/overview.md), [frontend](architecture/frontend.md), [backend](architecture/backend.md), [IPC](architecture/ipc.md), [project structure](architecture/project-structure.md). |
| [development/](development/) | Day-to-day: [commands](development/commands.md), [conventions](development/conventions.md), [testing](development/testing.md), [debugging](development/debugging.md), [performance](development/performance.md). |
| [product/](product/) | What Clippity does — [concepts](product/concepts.md), [features](product/features.md). |
| [decisions/](decisions/README.md) | Architecture Decision Records (ADRs) — the "why" behind non-obvious choices. |
| [roadmaps/](roadmaps/README.md) | Per-area roadmaps (capture, editor, library, sharing, vision, performance). |
| [reference/](reference/) | Keybind references ([editor](reference/editor-keybinds.md), [library](reference/library-keybinds.md)). |
| [ux-review/](ux-review/README.md) | A captured UX-review pass with annotated screenshots. |

## Quick start

```bash
pnpm install        # from the repository root
pnpm tauri:dev      # launch the desktop app
```

New to the codebase? Read [architecture/overview.md](architecture/overview.md),
then [architecture/project-structure.md](architecture/project-structure.md).
