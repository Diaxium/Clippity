// Hide the console window on Windows release builds (without this, the app
// flashes a console because the binary defaults to the console subsystem).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Thin bin entry — all setup lives in the library so it can be reused
// by tests, benches, and the Tauri test harness.
fn main() {
    clippity_lib::run();
}
