# UX review tooling

Clippity excludes its own windows from screen capture (the capture shield), so
the app cannot screenshot itself and most capture tools see a blank rectangle
where its windows should be. This folder holds the tooling used to take
review screenshots of the running app anyway.

## `snap.ps1`

Copies a Clippity window, as composited on screen, into a PNG under
`docs/ux-review/snapshots/`. Because it copies the composited desktop cropped
to the window's rectangle, transparent and Mica-backed chrome renders exactly
as the user sees it.

```powershell
# The foreground Clippity window (or the first visible one)
.\docs\ux-review\snap.ps1 -Name screen-01-capture-default

# A window by its exact title
.\docs\ux-review\snap.ps1 -Name screen-02-overlay -Title "Clippity Region Capture"

# The whole primary monitor
.\docs\ux-review\snap.ps1 -Name screen-03-full -FullScreen

# Include 16 px of surrounding desktop on every side
.\docs\ux-review\snap.ps1 -Name screen-04-toast -Title "Clippity Toast" -Pad 16
```

Window titles are set in `create_app_windows`
([`src-tauri/src/lib.rs`](../../app/backend/src-tauri/src/lib.rs)):
`Clippity Region Capture` (overlay), `Clippity Countdown`,
`Clippity Recording Area`, and `Clippity Toast`. The capture, main, and tray
windows are all titled `Clippity`, so select those by bringing them to the
foreground and omitting `-Title`.

| Parameter | Meaning |
| --- | --- |
| `-Name` | Output file name, without `.png`. Required. |
| `-Title` | Exact window title to capture. Omit to use the foreground Clippity window. |
| `-FullScreen` | Capture the whole primary monitor instead of a window. |
| `-Pad` | Extra pixels to include around the window rectangle. |

If no visible window matches, the script exits with an error listing the
titles of the Clippity windows it did find.

The screenshots used in the top-level README live in
[`docs/assets/screenshots/`](../assets/screenshots/).

For reviewing a single screen without the native app, the frontend's
[design-review harnesses](../getting-started/development.md#design-review-harnesses)
render the editor, overlay, library, settings, and Studio with seeded data in
an ordinary browser.
