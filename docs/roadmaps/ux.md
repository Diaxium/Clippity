# UX and workflow roadmap

## Current state

Individual interactions are thoughtful: overlay guidance changes by phase, the
tray exposes high-frequency actions, editor keybinds are extensive, library
selection semantics are documented and empty states are generally actionable.
The larger journey is fragmented across windows and settings, and several
states optimize for capability display rather than confidence and completion.

## Strengths to preserve

- Fast access through hotkey/tray and low-friction default capture.
- Contextual instructions, direct manipulation and reversible editor history.
- Local-first defaults and progressive editor inspectors.
- Separate simple capture and deep editing surfaces.

## Problems and missed opportunities

- Onboarding asks users to configure before they experience value.
- Capture → result → library/editor behavior changes with toggles and can be hard
  to predict.
- Error handling often keeps a form open or shows a toast without guided repair,
  retry details or a durable activity record.
- Power features are discoverable mainly through dense menus/docs; shortcuts are
  not customizable.
- No consistent undo for post-capture file actions, recipe execution or batch
  organization.

## Initiatives

| ID | Class | Recommendation | Priority | Impact | Complexity | Dependencies |
| --- | --- | --- | --- | --- | --- | --- |
| UX1 | Quick win | Value-first onboarding: permission check, practice capture, result action, hotkey/tray education, privacy statement and skippable checklist. | P1 | High | M | Onboarding/screens/docs. |
| UX2 | Foundation | Canonical capture-result flow with visible destination, reversible delete, retry, edit, copy, organize and share actions. | P0 | High | L | Event/domain contract. |
| UX3 | Foundation | Define global feedback rules: optimistic vs confirmed, progress/cancel, error codes, retry, focus restoration and activity history. | P0 | High | M | Error taxonomy, UI primitives. |
| UX4 | Foundation | Command palette and searchable shortcut help; editable conflict-checked shortcuts and reset/import/export. | P1 | High | L | Settings/keybind registries. |
| UX5 | Major | Recipe builder centered on outcomes (“capture bug report to folder and clipboard”), with templates and dry-run preview. | P1 | Transformative | XL | Recipe architecture. |
| UX6 | Major | Batch-first library workflows: persistent selection, action preview, undo and background progress. | P1 | High | L | Job model, library queries. |
| UX7 | Experiment | Adaptive hub/tray that learns pinned modes/recipes locally while remaining user-controlled and resettable. | P3 | Medium | M | Local usage model/privacy. |

## User journey targets

- **First-time:** launch → understand privacy/permissions → practice capture →
  copy/use result in under three minutes.
- **Experienced:** hotkey → select → result delivered in one continuous flow.
- **Power user:** invoke named recipe from shortcut/tray/CLI with no main-window
  visit; inspect failures later.
- **Accessibility user:** complete the same journeys by keyboard and receive
  equivalent state/progress announcements.

## Milestones and implementation phases

- **Short term:** journey maps and usability baseline, UX1–UX3, terminology and
  no-dead-end cleanup.
- **Mid term:** UX4–UX6, plus recorder and search workflows tested with real user
  tasks.
- **Long term:** adaptive surfaces and cross-device/team journeys only after
  local workflows retain users.

Use observe → prototype → moderated test → instrumented cohort → iterate → GA.
Every flow needs cancellation, interruption, permission denial, disk-full,
offline and restart recovery paths before completion.

## Success criteria

- First useful capture median <3 minutes; ≥70% first-session activation.
- Frequent still capture requires one trigger, one selection and zero cleanup
  steps when defaults are used.
- ≥90% task completion and <10% critical error rate in moderated core-workflow
  tests across all four personas.
- Support questions “where did it save?” and “how do I repeat this?” fall below
  2% of sessions in feedback sampling.
- Recipe users report ≥30 seconds saved per repeat run and repeat weekly.

## Risks, tradeoffs and alternatives

- A large result panel can slow the “capture and disappear” use case; default to
  compact reversible toast with an expandable activity view.
- Adaptive UI can feel unpredictable; use explicit pin/reorder suggestions, not
  silent rearrangement.
- More confirmations increase safety but add friction; confirmations should be
  proportional, with undo preferred for recoverable actions.

