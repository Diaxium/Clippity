# Conventions

## Workspace

- **pnpm only.** One root lockfile. Never introduce a nested lockfile or a
  second workspace config.
- **Everything from the root.** No command should require `cd`-ing into a
  package; add a root script (or a pnpm `--filter`) instead. See
  [commands.md](commands.md).
- **Internal deps use `workspace:*`.** The frontend depends on
  `@clippity/shared` this way.
- **Shared dev tooling at the root; runtime deps in the owning package.**
  TypeScript, ESLint, and Prettier live in the root `devDependencies`;
  React/Vite/Tailwind stay in the frontend, the Tauri CLI in `src-tauri`.

## Frontend (TypeScript / React)

- Strict TypeScript (`strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`). Use `import type` for type-only imports.
- Feature code lives under `features/<name>/`; it never reaches into another
  feature's internals. Cross-feature backend calls go through
  `services/tauri`; cross-feature UI/hooks through `shared/`.
- IPC wire types come from `@clippity/shared` (re-exported by the matching
  `services/tauri/clients/<domain>.ts`), never re-declared per feature.
- Path aliases (`@`, `@features`, `@services`, `@shared`, …) over deep
  relative paths.

## Backend (Rust)

- Respect the crate DAG (`infra → domain → platform/vision → services →
  src-tauri`); never add an upward edge. Emit events via
  `clippity-infra::events`, not the app crate.
- `domain` stays pure — no I/O, no Tauri. If a type needs the outside world,
  it belongs in a service.
- Command handlers in `app::commands` stay thin: validate via `domain`, call a
  service, return a serializable result.
- Declare dependency versions once in `[workspace.dependencies]`; crates
  reference them with `{ workspace = true }`.

## Decisions

Record non-obvious choices as an ADR in [decisions/](../decisions/README.md).
