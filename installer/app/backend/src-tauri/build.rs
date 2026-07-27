fn main() {
    // Embed a custom Windows application manifest that declares an explicit
    // `asInvoker` execution level. The shipping binary is a large exe named
    // "Clippity Setup" that embeds the application payload; without an
    // explicit requestedExecutionLevel, Windows' installer-detection
    // heuristic auto-elevates it, defeating the no-UAC per-user install path.
    // See windows-app-manifest.xml for the rationale. The manifest also keeps
    // Tauri's Common-Controls v6 dependency so the webview host is unaffected.
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let attributes = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
