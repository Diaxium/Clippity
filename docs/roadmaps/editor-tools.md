# Editor tools roadmap

## Current state and strengths

The editor is already a capable non-destructive scene tool with annotate/design
modes; selection, hand, crop, frame, shapes, line/arrow, text, image, pen/pencil;
blur, pixelate, magnifier, highlight, step, callout, spotlight, measure and
stamps; layers, multi-select, grouping, blend modes, gradients, effects,
backdrop/window chrome, undo/redo, editable scene save and flattened export.
Its renderer and geometry tests are a major asset.

## Gaps and opportunities

- Save As behaves like Save; editable save does not refresh the library preview.
- Frames double as groups, so ungroup can dissolve an intentional frame.
- Rich text, styled runs, text measurement/auto-size and typography fallbacks
  are limited.
- Image/video wording exceeds the scene's media capabilities.
- Large images remain decoded while hidden; source embedding increases scene
  size; document version/migration needs formalization.
- Canvas operations need a complete keyboard/screen-reader alternative.

## Delivery portfolio

| Phase | Initiative | Priority | Impact | Complexity | Dependencies |
| --- | --- | --- | --- | --- | --- |
| E0: completion (0–8 wk) | Real Save As, autosave/recovery, preview refresh choice, import from empty state, clear dirty/close behavior, export format/scale/metadata controls. | P0/P1 | High | L | Atomic persistence, result/export contract. |
| E1: model health (2–4 mo) | Distinct group node, versioned scene migrations, linked assets/dedupe option, relink/missing-source UI and layer-tree accessibility. | P1 | High | XL | Architecture A2/A6, AX5. |
| E2: annotation speed (3–6 mo) | Style presets, annotation templates, reusable stamps/brand kits, smart numbering, alignment/distribution and better snapping. | P1 | High | L | Recipe/template schema. |
| E3: content tools (4–9 mo) | Rich text runs, OCR-to-editable-text, smart redaction, perspective/keystone, multi-page/narrative documents and diff layers. | P2 | High | XL | Vision, narrative/export. |
| E4: media/AI (6–18 mo) | ~~Video trim~~ **done** — playback, scrubbing and trim ship as **Studio**, a surface beside this one ([ADR 0032](../decisions/0032-studio-is-a-separate-surface-that-streams-and-re-encodes.md)); remaining: annotation timeline, tracked callouts/redaction and optional on-device annotation suggestions. | P3 | Transformative | XL | Recorder/GPU/vision maturity. |

## Implementation phases

Characterize SVG and flattened render parity → version the scene schema → add
migration/fault fixtures → implement command/state layer → expose accessible
layer/inspector controls → add canvas UI → visual/performance regression → user
documentation. Do not add a tool until both preview and export renderers agree.

## Success criteria

- No lost edits after crash/close; recovery restores the last autosave and never
  overwrites a known-good scene silently.
- Preview/export visual mismatch remains below the defined pixel tolerance for
  every node/effect.
- Frequent annotation sequence is ≥30% faster in task tests; reusable styles are
  adopted by ≥20% of editor users.
- 500-node scenes remain ≥55 fps for ordinary manipulation on reference
  hardware; hidden-window memory is bounded.
- All layer operations and numeric transforms work without pointer input.

## Risks and alternatives

- Rich text and video timelines can turn a capture editor into a general design
  suite; optimize for explanation/redaction, not unrestricted creative tooling.
- Embedding sources maximizes portability but inflates scenes; offer portable
  package export while normal local scenes reference content-addressed assets.
- AI suggestions should be optional and reversible; deterministic tools remain
  the primary path.

