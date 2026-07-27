# Clippity product roadmaps

This roadmap set is the result of a repository-wide and live-product audit on
2026-07-22. It covers the capture hub, overlay, main workspace, library,
editor, presets, settings, onboarding, tray, countdown and toast windows; the
React/Tauri IPC seam; Rust services and domain rules; tests, documentation,
build tooling and release posture.

Clippity's core is already real: fast native capture, unusually rich region
selection, on-device OCR/object detection, a layered editor, a structured
library, presets and polished Windows chrome. The next chapter is not “add
everything.” It is to make the existing breadth feel coherent, trustworthy and
effortless, then grow Clippity from a screenshot tool into a private visual
workflow studio.

## Planning language

| Label | Meaning |
| --- | --- |
| P0 | Release blocker or trust/reliability foundation. |
| P1 | High-leverage improvement for most active users. |
| P2 | Important expansion after foundations are measurable. |
| P3 | Experimental bet; validate before committing deeply. |
| Short term | 0–8 weeks. |
| Mid term | 2–6 months. |
| Long term | 6–18 months. |
| Impact | Expected end-user value: low / medium / high / transformative. |
| Complexity | Delivery cost/risk: S / M / L / XL. |

## Recommended product strategy

1. **Make trust visible.** Harden IPC and file boundaries, add crash-safe
   persistence, ship a real update/release process and communicate local-first
   behavior clearly.
2. **Unify the journey.** Treat capture → refine → organize → reuse/share as
   one workflow across the capture window, overlay, toast, editor and library.
3. **Finish promises before multiplying them.** Complete recording, settings,
   export/share and search before placing more “Soon” destinations in primary
   navigation.
4. **Turn repetition into leverage.** Evolve presets into recipes with triggers,
   steps and destinations; make the tray and command palette the power-user
   surface.
5. **Differentiate through private intelligence.** On-device OCR, visual search,
   redaction, UI-element understanding and change detection can make Clippity
   feel smart without requiring users to surrender their captures.

## Integrated horizons

| Horizon | Outcome | Must-deliver initiatives | Exit criteria |
| --- | --- | --- | --- |
| 0. Baseline (week 0–2) | The team can measure and release safely. | CI, signed release checklist, event/error taxonomy, product metrics spec, a11y and performance baselines, security fixes S1–S4. | Clean CI on every change; no P0 security findings; documented p50/p95 capture latency and failure rate. |
| 1. Coherence (week 2–8) | The existing MVP feels complete. | Unified capture/result flow, truthful navigation, settings completion, import, Save As, library search improvements, keyboard/a11y fixes. | ≥99.5% successful capture completion; new-user first capture median <3 min; zero dead-end primary destinations. |
| 2. Workflow product (month 2–6) | Clippity saves meaningful repeated effort. | Recording, workflow recipes, full-text/OCR search, batch export/share, pin/shelf, diagnostics/update center. | ≥25% of WAU use a preset/recipe weekly; median capture-to-output steps reduced 30%; p95 library search <150 ms at 50k items. |
| 3. Differentiation (month 6–12) | Clippity becomes a private visual knowledge tool. | Change detection, smart redaction, semantic/visual retrieval, narrative documentation, plugin-safe output actions. | Two differentiated workflows each used by ≥15% of retained users; 8-week retention improves ≥20% over baseline. |
| 4. Platform (month 12–18+) | Ecosystem and sustainable growth. | macOS parity, optional encrypted sync/team spaces, public automation API/CLI, extension SDK and template marketplace. | Platform-specific capture success ≥99%; sync conflict-loss rate 0; ecosystem contribution and paid conversion targets met. |

## Portfolio map

### Audit and category roadmaps

- [Current-state audit](current-state-audit.md)
- [Integrated delivery plan](delivery-plan.md)
- [Performance](performance.md)
- [Features](features.md)
- [Screens and navigation](screens-navigation.md)
- [UI and design system](ui.md)
- [UX and workflows](ux.md)
- [Architecture and data](architecture.md)
- [Security and privacy](security-privacy.md)
- [Accessibility and inclusive design](accessibility.md)
- [Testing and quality](testing.md)
- [Documentation](documentation.md)
- [Developer experience](developer-experience.md)
- [Long-term product growth](product-growth.md)

### Cross-functional product-area roadmaps

- [Capture and recording](capture.md)
- [Editor tools](editor-tools.md) and [editor improvement view](editor-improvement.md)
- [Library and organization](library-organization.md)
- [Sharing and export](sharing-export.md)
- [Vision and on-device AI](vision-ai.md)

## Work classes

### Quick wins

- Remove or relocate primary-navigation “Soon” rows; use a small Labs page for
  genuinely testable previews.
- Add Import from file/clipboard/drag-and-drop and surface “Repeat last region”
  outside the tray.
- Complete About, updates, shortcuts and privacy summary screens.
- Fix the custom Select pattern, minimum target sizes, muted-text contrast and
  keyboard focus restoration.
- Add Save As, “open/reveal/copy path” labels that reflect what actually happens,
  and a post-capture undo/delete action.

### Foundational improvements

- Split Tauri permissions per window, add a CSP, harden path containment and
  cryptographically verify model/update artifacts.
- Introduce atomic versioned persistence and recovery for settings, collections,
  presets and sidecars.
- Add CI, native smoke tests, accessibility checks, visual regression and
  performance budgets.
- Establish one navigation vocabulary, design-token contract and event/error
  telemetry model.

### Major initiatives

- Real screen recording with region/window/fullscreen, audio, cursor treatment,
  trim and GIF/video export.
- Searchable visual library: OCR index, saved searches, duplicates, batch tools
  and optional semantic retrieval.
- Workflow recipes: capture + transform + redact + name + route + notify, with
  tray, shortcut, CLI and scheduled triggers.
- Change detection and narrative documentation built from capture sequences.

### Experiments

- “Live Lens” that identifies UI components, text, colors and spacing under the
  cursor and copies useful structured output.
- Local visual change monitors for a region/window with privacy-aware schedules.
- A temporary capture shelf that behaves like a visual clipboard and expires
  automatically.
- Optional encrypted collaboration spaces and a sandboxed output-action SDK.

## Dependency spine

```text
security + data integrity + CI
  -> reliable capture/result contract
    -> unified workflows and completed settings
      -> recording/search/recipes
        -> private intelligence and integrations
          -> sync, collaboration and ecosystem
```

Every major feature must include its screens, empty/error states, keyboard and
screen-reader behavior, persistence/migration path, performance budget, user
documentation, event instrumentation and native end-to-end coverage. A feature
is not complete when only its happy-path component exists.

## Portfolio-level success measures

- **Reliability:** successful capture completion ≥99.5%; crash-free sessions
  ≥99.8%; no unrecoverable settings/library corruption.
- **Speed:** hotkey-to-overlay p95 <250 ms; selection-to-result p95 <1.5 s for a
  4K still; tray idle CPU effectively 0%; main-window warm show p95 <300 ms.
- **Activation:** ≥70% of new users complete a capture and copy/export it in the
  first session; median first useful capture <3 minutes.
- **Efficiency:** repeat workflows require ≤2 user actions; ≥25% of weekly users
  run a recipe/preset; batch operations reduce repeated actions by ≥50%.
- **Accessibility:** WCAG 2.2 AA for application UI; all primary workflows
  keyboard-completable; zero serious automated a11y violations.
- **Trust:** every network action is explicit and inspectable; signed artifacts
  are verified; privacy controls are discoverable; security response process is
  published before a public release.

## Roadmap governance

Review this portfolio monthly. Promote an experiment only after a defined cohort
shows repeat use, not just interest. Each initiative gets an owner, decision
record, leading metric, rollback plan and “not doing” statement. Re-baseline
priorities after the first four weeks of real product telemetry and user
interviews; estimated priority is not a substitute for observed friction.
