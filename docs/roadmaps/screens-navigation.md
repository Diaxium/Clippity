# Screens and navigation roadmap

## Current state

The product uses six dedicated windows. The capture window owns Capture,
Record, History and Presets; the main window owns Editor, Library, Presets and
Settings; utility windows handle overlay, tray, toast and countdown. Modals and
subviews include onboarding, preset editing, palette detail, inspectors,
keybind help and context menus. Visual hierarchy is strong, but vocabulary and
destination availability differ between windows.

## Strengths to preserve

- Purpose-built utility windows keep capture interactions immediate.
- The overlay and tray optimize for focus rather than resembling a generic app.
- Library/editor/presets share a stable main-workspace shell.
- Empty states usually provide a clear next action.

## Problems and missed opportunities

- “History” and “Library” name the same user goal; Presets appears in two shells;
  settings/theme controls are duplicated.
- Prominent Record and eight settings destinations are dead-end placeholders.
- The main app has no Home/Today view, command palette, global activity/recovery
  surface or clear back-stack model.
- Editor has no direct import/open control in its empty state.
- Capture outputs can feel as if they disappear when preview is off.

## Screen portfolio

| ID | Class | Screen/change | Priority | Impact | Complexity | Dependencies |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Quick win | Normalize labels: Library everywhere; Capture/Record as actions; Presets managed in one canonical view. | P0 | Medium | S | Copy/navigation decision. |
| S2 | Quick win | Replace disabled settings rows with implemented About, Shortcuts and Privacy Summary; move real previews to a Labs page. | P0 | High | M | Settings/security docs. |
| S3 | Foundation | Add a lightweight Home/Today screen with quick capture, continue editing, recent items, recipes and storage/update alerts. | P1 | High | M | Unified navigation/result model. |
| S4 | Foundation | Add global command palette and consistent deep links (`clippity://capture/region`, library query, recipe id, editor item). | P1 | High | L | Shortcut/URI security. |
| S5 | Major | Recorder setup, recording HUD and trim/export screens. | P1 | Transformative | XL | Recording backend. |
| S6 | Major | Search Center and capture detail/activity timeline with provenance, OCR, versions and related items. | P1 | High | L | Search/index schema. |
| S7 | Major | Workflow Builder, run history and recoverable failure detail. | P2 | High | XL | Recipe/job architecture. |
| S8 | Major | Privacy Center, Storage Health, Diagnostics and Update Center. | P1 | High | L | Security, observability, updater. |
| S9 | Experiment | Capture Shelf utility window and change-monitor dashboard. | P3 | High | L | Retention/scheduler. |

## Milestones and implementation phases

- **Short term:** navigation vocabulary, no dead ends, direct editor import,
  result visibility, About/Shortcuts/Privacy Summary.
- **Mid term:** Home, command palette/deep links, recorder screens, Search Center
  and diagnostics/update/storage screens.
- **Long term:** workflow builder, activity timelines, shelf and monitoring.

Phase each screen through information architecture → keyboard/focus map → empty,
loading, offline, permission and recovery states → responsive/HiDPI validation →
native E2E and analytics. Do not ship a navigation row before its primary task
can complete.

## Success criteria

- Zero primary-navigation dead ends or “Soon” pages in stable builds.
- ≥90% first-click success for Capture, find recent capture, change shortcut,
  inspect privacy and update app in usability tests.
- Users can reach any frequent action in ≤2 navigation actions or command-palette
  invocation.
- Focus returns predictably after every modal/window transition; all deep links
  reject invalid/untrusted payloads safely.

## Risks, tradeoffs and alternatives

- A Home screen can become dashboard clutter; keep it action-led and removable.
- Unifying windows into one shell would reduce conceptual switching but could
  harm capture speed; retain dedicated native windows with shared vocabulary.
- Deep links expand the attack surface; allow closed, validated actions and
  require confirmation for destructive/output actions.

