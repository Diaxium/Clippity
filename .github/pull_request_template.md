<!--
Thanks for the PR. Keep it to one concern — a refactor bundled with a feature
is two reviews wearing a trenchcoat.
-->

## What changed

<!-- Describe the behavior change, not just the diff: what did the app do
before, and what does it do now? -->

## Why

<!-- Link the issue if there is one: Fixes #123 -->

## How it was verified

<!-- The steps you actually ran in the app, plus the Windows version you ran
them on. Screenshots or a clip for anything visual — Clippity excludes its own
windows from screen capture, so use a phone, a second machine, or another
capture tool. -->

## Checklist

- [ ] `pnpm check` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] IPC changes touch both sides — `app/shared/src/contracts` and the Rust `domain` structs
- [ ] A non-obvious decision is recorded as an ADR in `docs/decisions/`
- [ ] Docs updated if behavior, commands, or keybinds changed
