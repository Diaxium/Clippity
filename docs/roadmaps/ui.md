# UI and design-system roadmap

## Current state

Clippity has a distinctive, cohesive desktop visual language: warm coral accent,
soft surfaces, Mica/transparent chrome, light/dark themes, compact density and
shared primitives. The editor has its own mapped token layer. Many values are
tokenized, and accent/motion/window-effects settings already cascade globally.

## Strengths to preserve

- Clear hierarchy, consistent radii and restrained elevation.
- Native-feeling title bars and focused utility-window compositions.
- Accent customization without abandoning semantic states.
- Reduced motion, forced-colors treatment for key overlay elements and a flat
  effects mode.

## Problems and missed opportunities

- Small 11–13 px labels and 20 px switches are visually elegant but can be hard
  to read or target.
- Muted text is intentionally low contrast and needs systematic AA verification.
- UI primitives are hand-built and behavior coverage is uneven; the custom
  Select explicitly does not implement the complete ARIA pattern.
- Capture, overlay, dashboard and editor sometimes feel like adjacent design
  systems rather than one adaptable system.
- No component explorer, token documentation, screenshot regression matrix or
  density/text-scale setting exists.

## Initiatives

| ID | Class | Recommendation | Priority | Impact | Complexity | Dependencies |
| --- | --- | --- | --- | --- | --- | --- |
| UI1 | Quick win | Audit contrast, target size, focus rings, truncation and 200% text scaling across every window/theme/accent. | P0 | High | M | Accessibility matrix. |
| UI2 | Foundation | Formalize semantic tokens (surface, content, border, focus, success/warn/error, selection) and remove one-off color/spacing values. | P1 | Medium | M | Token inventory, visual tests. |
| UI3 | Foundation | Build accessible primitives for select/combobox, dialog, menu, tooltip, tabs, toast/live region, tree and virtual list. | P0 | High | L | Accessibility tests. |
| UI4 | Foundation | Add a component explorer with all themes, accents, forced colors, reduced motion and localization stress cases. | P1 | Medium | M | DX tooling. |
| UI5 | Major | User-selectable comfortable/compact density and text scale; adaptive layout at narrow and HiDPI sizes. | P1 | High | L | Tokenized sizing. |
| UI6 | Major | Reconcile app/editor/overlay tokens into one documented system with context variants, not forks. | P2 | Medium | L | UI2, editor review. |
| UI7 | Experiment | Optional brand kits/templates for export backdrops, chrome, annotations and watermarking. | P3 | Medium | L | Editor/export model. |

## Milestones and implementation phases

- **Short term:** contrast/target audit, accessible Select/dialog/menu fixes,
  screenshot baseline and semantic error/status tokens.
- **Mid term:** component explorer, token consolidation, density/text scale and
  cross-window consistency pass.
- **Long term:** brand/template system and public design-system guidance.

Implement primitive-first: inventory usages → define behavioral contract → add
keyboard/screen-reader tests → migrate one surface → visual diff → migrate all
surfaces → delete legacy styling.

## Success criteria

- WCAG 2.2 AA contrast for text/components across supported themes and accents.
- Primary targets ≥24×24 CSS px with ≥44×44 spacing/touch target where relevant.
- No clipping/overlap at 200% text scale or supported Windows scaling factors.
- 100% of shared primitives represented in the explorer and visual-regression
  matrix; no serious automated accessibility violations.
- Cross-window UI consistency scores ≥90% in design review checklist.

## Risks, tradeoffs and alternatives

- Increasing size may reduce the compact professional feel; density modes let
  users choose without compromising defaults.
- Replacing primitives can introduce regressions; keep prop contracts stable and
  migrate incrementally.
- Third-party headless primitives can improve semantics but add weight; assess
  bundle/runtime cost against maintaining behavior internally.

