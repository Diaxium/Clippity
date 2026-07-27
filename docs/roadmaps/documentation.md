# Documentation roadmap

## Current state

Architecture, commands, product concepts, editor/library keybinds, performance
investigations and 22 surviving ADRs are valuable and unusually detailed. The
documentation is developer-heavy: user help, troubleshooting, release/security
policy and in-app contextual guidance are thin. Before this roadmap set,
`docs/roadmaps/` was empty despite many references. `docs/ux-review/README.md`
is still absent, historic test totals are stale, the build artifact path is
outdated and ADRs 0001–0008 are explicitly lost.

## Strengths to preserve

- Docs live with code and explain why, not only how.
- Keybind references and ADRs document complex behavior precisely.
- Root-oriented commands and architecture onboarding are clear.
- Performance reports include evidence, tradeoffs and validation.

## Problems and missed opportunities

- No user manual organized by outcomes, searchable in-app help or first-run
  troubleshooting.
- No CONTRIBUTING, SECURITY, changelog, release notes, support bundle guide,
  compatibility matrix or privacy/model-download explanation.
- No link checker, snippet/test-count validation or doc ownership/freshness gate.
- Code comments link to missing/lost roadmap and ADR material.
- Docs do not distinguish stable, beta/Labs, platform-specific and planned
  capabilities consistently.

## Initiatives

| ID | Class | Recommendation | Priority | Impact | Complexity | Dependencies |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | Quick win | Fix all broken/stale links, artifact paths and historic/current validation labels; add UX-review index. | P0 | Medium | S | Link checker. |
| D2 | Foundation | Create outcome-based user guide: first capture, each mode, organize/search, edit, export/share, presets/recipes, privacy, accessibility and recovery. | P1 | High | L | Stable UX/copy. |
| D3 | Foundation | CONTRIBUTING, SECURITY, support/troubleshooting, release process, compatibility matrix, data map and model/update provenance docs. | P0 | High | M | Security/release decisions. |
| D4 | Foundation | CI checks for links, code snippets, generated command/schema references and required changelog/release notes. | P1 | Medium | CI/contract generation. |
| D5 | Major | In-app searchable help and contextual “?” routes generated from the same docs source; offline by default. | P1 | High | Screens/search. |
| D6 | Major | Reconstruct decision summaries for lost ADRs from current code as clearly marked retrospective records; never pretend original text was recovered. | P2 | Medium | Maintainer review. |
| D7 | Major | Public roadmap/changelog discipline with shipped/beta/planned labels and migration notes. | P1 | Medium | Product governance. |

## Milestones and implementation phases

- **Short term:** D1, D3 and automated link checking; update docs alongside the
  first security/release changes.
- **Mid term:** D2, D4–D5 and release notes/data/recovery guides.
- **Long term:** retrospective decisions, localized help and public roadmap.

Use task inventory → canonical source owner → write/test with a new user → link
from UI → automate freshness → review each release. Generated references should
not duplicate hand-written explanations.

## Success criteria

- Zero broken internal links or undocumented primary workflows in CI.
- A new contributor reaches a green check/test and launches the app within 30
  minutes using docs alone.
- ≥80% of common help queries resolve in-app without external support.
- Every release has user-facing notes, migration/recovery notes and an updated
  compatibility/security status.
- Every P0/P1 feature PR updates its user docs and relevant ADR/roadmap state.

## Risks, tradeoffs and alternatives

- Documentation can describe aspiration as reality; visibly label stable, beta,
  platform-specific and planned behavior.
- Generated docs can be correct but unusable; pair them with task-based prose.
- Retrospective ADRs risk rewriting history; label evidence, inference and
  unknowns explicitly.

