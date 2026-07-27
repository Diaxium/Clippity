// Hide the console window on Windows release builds (without this, the
// setup wizard flashes a console because the binary defaults to the
// console subsystem).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Thin bin entry — all setup lives in the library so it can be reused by
// tests and the Tauri test harness. The library returns a process exit code
// (0 on success, a stable non-zero for silent-operation failures) which we
// propagate so unattended deployment can branch on the result.
fn main() -> std::process::ExitCode {
    clippity_installer_lib::run()
}
