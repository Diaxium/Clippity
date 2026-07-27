# Developer-experience roadmap

## Current state

The root pnpm/Cargo workspace, strict TypeScript, path aliases, feature modules,
layered crates, shared commands and colocated tests create a good daily
foundation. Root commands are documented and all quality gates currently pass.
DX gaps are reproducible toolchains, CI, seeded native development, component
isolation, contract generation, diagnostics and release automation.

## Strengths to preserve

- One root-level workflow and lockfile.
- Clear frontend/backend ownership boundaries and narrow service clients.
- Fast scoping to individual packages/crates/tests.
- Rich code comments and decisions around complex behavior.

## Problems and missed opportunities

- Node has only a broad `>=18` requirement while pnpm and modern Vite versions
  are pinned elsewhere; no `rust-toolchain.toml` or setup verification command.
- Native development depends on Windows/ORT/WebView/system behavior without a
  deterministic fixture mode.
- No CI, pre-commit checks, automated dependency updates, cache strategy or
  release orchestration.
- No component explorer, sample library/scene corpus, IPC schema generator or
  log/diagnostic viewer.
- Very large modules increase review and merge-conflict costs.

## Initiatives

| ID | Class | Recommendation | Priority | Impact | Complexity | Dependencies |
| --- | --- | --- | --- | --- | --- | --- |
| DX1 | Quick win | Pin Node/Rust toolchains; add `doctor`, `clean`, `test:changed`, `docs:check` and `audit` commands. | P0 | High | S | Toolchain decisions. |
| DX2 | Foundation | CI with dependency/build caches, required checks, artifact previews and automated dependency PRs. | P0 | High | M | Testing/release. |
| DX3 | Foundation | Deterministic dev mode with fake monitors/windows/captures/OCR/models/clock and seeded small/huge/corrupt libraries. | P1 | High | Provider interfaces. |
| DX4 | Foundation | Component explorer and interactive smoke gallery for every window/state/theme/DPI. | P1 | High | UI roadmap. |
| DX5 | Foundation | Generate/validate IPC schemas and create domain-specific command modules; searchable command/event catalog. | P0 | High | Architecture A1. |
| DX6 | Major | Structured diagnostics console/support bundle with redaction, event correlation ids and opt-in performance traces. | P1 | High | Observability/privacy. |
| DX7 | Major | Release command/pipeline for version, changelog, signing, SBOM, installers, update manifest, smoke, promotion and rollback. | P0 | High | Security credentials. |
| DX8 | Major | Incremental decomposition ownership map for editor/overlay/library monoliths with characterization gates. | P1 | Medium | Architecture A4. |

## Milestones and implementation phases

- **Short term:** DX1–DX2 and contract/link checks; make a clean machine green in
  one command.
- **Mid term:** DX3–DX7, component/fixture workflows and reproducible signed beta
  releases.
- **Long term:** continuous module decomposition and cross-platform toolchains.

Implement by timing current developer tasks → automate the slow/error-prone
steps → document escape hatches → measure onboarding/build/flake time → remove
obsolete paths.

## Success criteria

- Clean checkout to running fixture app <15 minutes; subsequent frontend change
  feedback <10 seconds and scoped unit feedback <5 seconds.
- Required CI p95 <15 minutes with <1% infrastructure flakes.
- One reviewed command creates a signed, SBOM-attached, smoke-tested beta and can
  promote/rollback it.
- Adding an IPC command requires one schema/source edit or fails conformance CI.
- New contributors ship a small change in their first day without undocumented
  environment fixes.

## Risks, tradeoffs and alternatives

- Excess scripts can hide fundamentals; commands should print underlying tools
  and remain composable.
- Fake providers may diverge from Windows reality; keep a smaller real-native
  release lane.
- Module decomposition for its own sake creates churn; split only around stable
  responsibilities and active roadmap work.

