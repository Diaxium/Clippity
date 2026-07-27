# Contributing to Clippity

Thanks for taking the time. Clippity is a Windows-first desktop capture suite
built on Tauri v2 — a React 19 + TypeScript frontend over a layered Rust
workspace. This document covers how to get set up, what the code expects of you,
and what CI checks before a merge.

## Before you start

- **Open an issue first for anything non-trivial.** A bug report or feature
  request costs you five minutes and can save a rewrite. Small fixes — typos,
  a broken link, an obvious one-liner — can go straight to a PR.
- **Check the roadmaps.** [docs/roadmaps/](docs/roadmaps/README.md) is where
  planned work lives, per area, with priorities. If your idea is already there,
  say so in the issue; if it contradicts a decision, read the relevant
  [ADR](docs/decisions/README.md) first — the reasoning is usually written down.

## Setup

See [docs/getting-started/prerequisites.md](docs/getting-started/prerequisites.md)
for the full list. In short: Node 18+, pnpm 11+, Rust 1.78+ with `rustfmt` and
`clippy`, and the Tauri v2 system dependencies (MSVC C++ Build Tools and
WebView2 on Windows).

```bash
pnpm install
pnpm tauri:dev
```

Everything runs from the repository root. There is one pnpm workspace and one
Cargo workspace, and no command requires `cd`-ing into a package.

The first native build downloads ONNX Runtime binaries through `ort`, so it
needs network access and takes a while. Later builds are incremental.

## Making a change

1. **Branch** off `main`.
2. **Match the code around you.** Naming, comment density, module layout, and
   error handling are consistent in this codebase on purpose — see
   [docs/development/conventions.md](docs/development/conventions.md).
3. **Keep the IPC seam typed.** Wire shapes are declared once in
   `app/shared/src/contracts` and mirrored by the Rust `domain` structs. If you
   change one side, change the other in the same commit.
4. **Respect the layering.** The Rust crates go `infra → domain →
   platform/vision → services → src-tauri`, and dependencies only point one
   way. `domain` does no I/O.
5. **Test what you changed.** Frontend logic and components use Vitest +
   Testing Library; domain rules and services use `cargo test`. See
   [docs/development/testing.md](docs/development/testing.md).
6. **Write an ADR for a non-obvious decision.** If someone could reasonably ask
   "why is it done *that* way?" six months from now, add a numbered record to
   [docs/decisions/](docs/decisions/README.md) instead of a comment that will
   drift.

## Before you open the PR

Run the same checks CI runs:

```bash
pnpm check && pnpm lint && pnpm test
```

- `pnpm check` — TypeScript type-check plus `cargo check --workspace`
- `pnpm lint` — ESLint and clippy
- `pnpm test` — Vitest (frontend + shared) and `cargo test --workspace`
- `pnpm format` — Prettier and rustfmt, if the formatter has opinions about
  your diff

Performance-sensitive work should also clear the benchmark budgets:

```bash
pnpm bench && pnpm bench:check
```

## Pull requests

- **One concern per PR.** A refactor bundled with a feature is two reviews
  wearing a trenchcoat.
- **Describe the behavior change, not just the diff.** What did the app do
  before, what does it do now, and how did you verify it?
- **Include a screenshot or clip for anything visual.** Clippity excludes its
  own windows from screen capture, so grab UI shots with a phone, a second
  machine, or another capture tool.
- **Note the platform you tested on.** Windows 10 and 11 behave differently for
  several capture paths.

## Reporting bugs

Use the bug report template. The details that actually shorten a fix:

- Windows version and build (`winver`)
- Whether you built from source or ran a bundle, and which
- The capture mode, monitor layout, and display scaling involved
- Logs — Clippity writes through `tracing`; see
  [docs/development/debugging.md](docs/development/debugging.md)

## Security

Please do not open a public issue for a vulnerability. Report it privately
through GitHub's **Security → Report a vulnerability** on this repository.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers this project.
