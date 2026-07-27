# Integrated delivery plan

This sequence turns the category roadmaps into an executable program. Team names
are capability owners rather than staffing assumptions; one person may own
several tracks in a small project.

## First eight weeks

### Weeks 1–2: establish the release and trust baseline

| Work package | Owner | Deliverable | Depends on | Exit signal |
| --- | --- | --- | --- | --- |
| Security boundary | Native/security | CSP, per-window capability matrix, component-aware path containment and artifact-scoped share/open commands. | Command/window inventory. | Security regression suite green; no utility window holds unrelated permissions. |
| Data safety | Native/data | Atomic versioned writes and recovery backups for settings, presets, collections, labels, provenance and scenes. | Schema inventory. | Fault injection never destroys last-known-good data. |
| CI/release skeleton | Quality/DX | Windows CI for install/check/lint/test/build; advisory scans, SBOM and unsigned internal artifact. | Runner and cache. | Every change receives a reproducible green/red result. |
| Product baseline | Product/UX | Event dictionary and privacy rules; measure capture success/latency, activation and failure categories locally/opt-in. | Canonical outcome definition. | Dashboard or reproducible report contains p50/p95 and failure rate without capture content. |
| Accessibility baseline | Design/quality | WCAG checklist, axe/component scan and manual keyboard/NVDA pass of capture, library and settings. | Screen inventory. | P0 violations filed with owners and acceptance tests. |

Decision gate: do not begin network integrations, sync or extension work until
the security/data/CI packages meet their exit signals.

### Weeks 3–4: make the existing product truthful and coherent

| Work package | Owner | Deliverable | Depends on | Exit signal |
| --- | --- | --- | --- | --- |
| Navigation cleanup | Product/frontend | Library terminology everywhere; no stable primary “Soon” destinations; implemented About, Shortcuts and Privacy Summary. | UX copy decision. | Zero dead-end primary rows in native E2E. |
| Capture result v1 | Cross-functional | Canonical result event plus compact actions: copy, edit, reveal, tag, delete/undo and visible save destination. | Data safety, artifact contract. | Every capture mode yields the same result envelope and recovery behavior. |
| Import and editor entry | Frontend/native | File dialog, drag/drop/open-with and clipboard ingest; editor empty state can import/open recent. | Path hardening. | Supported file enters library/editor from all entry points with clear errors. |
| Accessible primitives | Design/frontend | Complete Select, dialog, menu and focus-return behavior; target/contrast fixes. | Accessibility baseline. | Zero serious automated findings in shared primitives. |
| Native golden journey | Quality | Packaged-app test for first run → region capture fixture → result → library → editor save/export → restart. | CI, deterministic providers. | Stable pass rate ≥99% over repeated CI runs. |

### Weeks 5–6: prove first-use and repeated-use value

| Work package | Owner | Deliverable | Depends on | Exit signal |
| --- | --- | --- | --- | --- |
| Value-first onboarding | Product/design | Permission/privacy explanation, practice capture, result action, hotkey/tray education and resumable checklist. | Result v1, a11y primitives. | Median first useful capture <3 minutes in testing. |
| Preset completion | Product/frontend | Custom modes, effects/naming/output options, duplicate/reorder and import/export; label future recipe migration. | Artifact/result contract. | A user can save and repeat each stable capture mode. |
| Library findability v1 | Data/frontend | Provenance/tag/type/date query chips, saved query and import filters; query performance fixture. | Index migration framework. | Known-item task success ≥90%; p95 <150 ms at fixture scale. |
| Editor completion | Editor/native | Real Save As, autosave/recovery, preview-refresh choice and metadata-aware export sheet. | Atomic scenes, export contract. | Crash/restart test restores work; Save As produces independent editable output. |
| Help/recovery | Docs/frontend | Outcome-based quick start, privacy/data map, troubleshooting and in-app contextual links. | Stable copy/error taxonomy. | Core tasks and top failure codes have tested help routes. |

### Weeks 7–8: release-candidate hardening and roadmap gate

| Work package | Owner | Deliverable | Depends on | Exit signal |
| --- | --- | --- | --- | --- |
| Signed beta pipeline | Release/security | Version/changelog, signing, installers, verified update manifest, install/update/rollback/uninstall smoke and staged channel. | CI, SEC4/SEC5. | One command produces a smoke-tested signed beta; rollback demonstrated. |
| Performance budget | Performance/quality | Reference-hardware measurements and regression thresholds for startup, overlay, save, library, editor and idle. | Instrumentation, native harness. | Budgets recorded and enforced in nightly/release lane. |
| Inclusive release pass | Design/quality | 200% text, DPI/theme/accent/high contrast/reduced motion and NVDA core-flow validation. | Weeks 3–6 UI. | No P0/P1 accessibility defect; status published honestly. |
| Beta cohort | Product/support | 20–50 representative users, structured feedback, crash/support intake and opt-in metrics. | Signed beta/help. | Reliability/activation baseline and ranked observed friction available. |
| Investment gate | Product/engineering | Choose next major initiative using cohort evidence: recording, search/recipes or both with explicit staffing. | Baseline metrics/interviews. | Written go/no-go with scope, success metric and work intentionally deferred. |

## Months 2–6: two coordinated product streams

### Stream A — workflow engine and searchable memory

1. Typed cancellable job service and recipe schema.
2. OCR/FTS index, saved searches, background derived assets and batch actions.
3. Recipe builder/templates, tray/shortcut/CLI triggers and run history.
4. Persistent thumbnail/virtualization work as corpus scale requires.

Exit: ≥25% of weekly users run a recipe; p95 search <150 ms at 50k entries;
repeated workflow actions fall ≥50%.

### Stream B — recorder

1. Deterministic audio/video providers, permission UX and crash-safe media job.
2. Region/window/fullscreen capture with mic/system audio and cursor treatment.
3. Recorder HUD, pause/stop, trim/export, library playback and presets.
4. Hardware cohort, A/V/performance/accessibility matrix and staged beta.

Exit: ≥99% successful recording, <100 ms 30-minute A/V drift, recoverable
partials and repeat use that justifies GIF/webcam/annotation expansion.

## Months 6–18: evidence-gated initiatives

| Initiative | Start when | Stop/rethink when |
| --- | --- | --- |
| Change detection | QA/support cohort repeats manual before/after workflows and artifact identity is stable. | Alignment false positives prevent trustworthy results. |
| Live Lens / smart redaction | Model supply chain and evaluation corpus are governed; users accept review-first suggestions. | Accuracy or latency harms fast rectangle capture. |
| Narrative documents | Users already sequence/export multiple captures repeatedly. | General document-layout complexity exceeds capture-specific value. |
| macOS | Windows core reliability and platform interfaces are stable; demand is validated. | Maintaining two platforms prevents either from meeting success targets. |
| Encrypted sync/team | Retained users demonstrate cross-device/team need and threat/conflict models pass independent review. | Trust/operational burden exceeds proven willingness to pay. |
| Extension marketplace | First-party recipe/output contract is stable and sandbox/signing exist. | Support/security cost outpaces ecosystem value. |

## Cross-cutting definition of done

Every work package must include:

- user problem, supported personas and an explicit non-goal;
- stable/beta/platform label and discoverable entry point;
- domain/IPC schema, migration/recovery and cancellation behavior;
- permission/privacy review and sensitive-data-safe diagnostics;
- keyboard/screen-reader/focus/contrast/zoom acceptance criteria;
- unit, contract, native E2E, failure and appropriate visual/performance tests;
- user/help/release documentation and measurable outcome event;
- rollout cohort, rollback plan and owner after launch.

## Program risks

- **Parallel overload:** recording, recipes and search share job/data/test
  foundations; sequence those foundations and cap active major initiatives.
- **Expectation debt:** stable navigation must reflect shipped tasks; Labs must
  be opt-in and removable.
- **Metrics without trust:** keep measurement content-free and optional; a
  reproducible local report is the fallback.
- **Architecture detour:** refactor along active feature seams and require a
  user-visible or risk-reduction outcome for each extraction.

