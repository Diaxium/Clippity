# Editor improvement roadmap

This is the cross-category view referenced by older ADRs. The canonical tool
plan is [editor-tools.md](editor-tools.md). Supporting work lives in:

- [UI](ui.md): tokens, primitives, density and visual regression.
- [UX](ux.md): result flow, feedback, shortcuts and recovery.
- [Architecture](architecture.md): scene migrations, persistence, artifact and
  job contracts.
- [Performance](performance.md): large images, hidden lifecycle and gesture
  budgets.
- [Accessibility](accessibility.md): layer-tree and keyboard equivalents.
- [Testing](testing.md): renderer differential/native/fault coverage.

## Integrated priorities

1. **P0 – never lose work:** atomic scene save, autosave/recovery, explicit dirty
   close and real Save As.
2. **P1 – make existing power faster:** style presets, alignment/distribution,
   smarter snapping, import and export controls.
3. **P1 – make it inclusive:** complete layer-tree/numeric operation and focus/
   announcement behavior.
4. **P1 – keep it fast:** large-image lifecycle and render-performance budgets.
5. **P2 – deepen the capture-specific advantage:** OCR text, irreversible
   redaction export, diff layers and narrative documents.
6. **P3 – extend to media only after recording succeeds:** timeline annotation
   and tracked effects.

The editor should remain the best place to explain a captured moment, not try to
replace a full illustration or video-production suite.

