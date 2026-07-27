# Accessibility and inclusive-design roadmap

## Current state

The app includes focus-visible styling, semantic buttons and switches, many
ARIA labels, reduced-motion support, a user motion setting, forced-color and
high-contrast treatment for parts of the overlay, and documented keyboard
systems. Accessibility is nevertheless uneven: the custom Select admits it is
not a complete listbox implementation, core overlay/editor tasks are highly
visual and pointer-led, many targets and labels are small, and no automated or
manual assistive-technology program exists.

## Strengths to preserve

- Keyboard-first editor/library intent and conflict-checked keybind registries.
- Motion/transparency preferences and theme tokenization.
- Semantic progress, alert, radio, listbox and switch work already present.
- Layer tree and inspector provide a potential non-canvas control surface.

## Problems and missed opportunities

- No declared WCAG target, VPAT/accessibility statement or issue process.
- No axe/Accessibility Insights/NVDA test suite or CI gate.
- Canvas selection, resizing, region capture, color/palette feedback and visual
  effects lack equivalent non-visual workflows.
- Muted contrast, custom accents, 200% text scaling, high DPI and keyboard focus
  across native-window transitions are unverified.
- No localization, RTL, dyslexia-friendly text/density or speech/voice strategy.

## Initiatives

| ID | Class | Recommendation | Priority | Impact | Complexity | Dependencies |
| --- | --- | --- | --- | --- | --- | --- |
| AX1 | Foundation | Adopt WCAG 2.2 AA; build a screen-by-screen keyboard, name/role/value, contrast, zoom, motion and error checklist. | P0 | High | M | Product ownership. |
| AX2 | Quick win | Replace incomplete Select/menu/dialog patterns; fix focus traps/return, live announcements, labels, target size and muted contrast. | P0 | High | L | UI primitives. |
| AX3 | Foundation | Add axe component checks, Accessibility Insights automation and scheduled manual NVDA/Windows High Contrast testing. | P0 | High | M | CI/native harness. |
| AX4 | Major | Accessible overlay: keyboard-positioned rectangle, window cycling, numeric coordinates/size, magnifier alternatives and spoken phase/dimension feedback. | P1 | Transformative | XL | Overlay state APIs. |
| AX5 | Major | Accessible editor: layer-tree manipulation, numeric transform, tool descriptions, selection announcements and full operation without canvas pointer input. | P1 | Transformative | XL | Editor commands/semantics. |
| AX6 | Major | Comfortable density, text scale, color-vision-safe palettes, non-color state cues and optional high-contrast theme. | P1 | High | L | UI tokens/settings. |
| AX7 | Major | Localization-ready strings, layout stress tests and RTL-safe primitives; prioritize languages from user data. | P2 | High | L | String extraction/docs. |
| AX8 | Experiment | Voice commands/dictation for capture and annotation, evaluated as an assistive option rather than primary navigation. | P3 | Medium | XL | OS speech/privacy. |

## Milestones and implementation phases

- **Short term:** AX1–AX3, remediate primary capture/library/settings flows and
  publish an honest accessibility status.
- **Mid term:** AX4–AX6, with disabled users included in design validation.
- **Long term:** localization/RTL and carefully scoped assistive experiments.

Use audit → severity triage → semantic primitive fix → keyboard/focus test →
screen-reader test → zoom/contrast/motion test → regression gate. Accessibility
acceptance criteria belong in every feature roadmap item, not a final audit.

## Success criteria

- Zero serious/critical axe findings; 100% primary workflows keyboard-complete.
- WCAG 2.2 AA contrast across supported theme/accent combinations.
- No content loss at 200% text zoom and supported Windows scaling.
- NVDA users complete capture, locate, edit, export and settings tasks with
  ≥90% success in moderated testing.
- Every modal/window transition has tested initial focus, escape behavior and
  focus return; progress/errors are announced once and at the right priority.

## Risks, tradeoffs and alternatives

- Automated tools detect only part of the problem; fund manual testing with
  assistive-technology users.
- A canvas DOM mirror can be complex; expose the existing layer/inspector model
  as the canonical accessible alternative instead of narrating every pixel.
- Global shortcuts can conflict with assistive technology; allow remapping and
  publish safe defaults.

