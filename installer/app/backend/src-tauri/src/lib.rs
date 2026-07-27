//! Clippity Setup backend — the `src-tauri` wizard shell crate.
//!
//! Top of a Cargo workspace whose layers are separate crates (top-down
//! dependency direction):
//!
//! ```text
//!   src-tauri (this crate) -- Tauri command handlers, the wizard window,
//!                             AppState
//!     ↓
//!   installer-services     -- install / modify / update / uninstall I/O
//!     ↓
//!   installer-platform     -- OS-specific impls (Win32 shortcuts, registry)
//!     ↓
//!   installer-domain       -- Pure types and rules (plans, versions, sizing)
//!     ↓
//!   installer-infra        -- Cross-cutting: errors, logging, paths
//! ```
//!
//! Crossing a layer is allowed only top-down. `installer-domain` knows
//! nothing about `tauri`, so the plan/version/size rules unit-test
//! without a desktop session.

pub mod app;

use std::process::ExitCode as ProcessExitCode;

use tauri::{WebviewUrl, WebviewWindowBuilder};

use installer_domain::cli::{self, ParsedCli};

/// Process entry point. Parses the command line first: `--help`/`--version`
/// print and exit, a silent maintenance command runs headless and exits
/// with a stable code, and anything else opens the interactive wizard.
///
/// Returns the process exit code so unattended deployment can branch on the
/// result (see [`installer_domain::cli::ExitCode`]).
pub fn run() -> ProcessExitCode {
    installer_infra::logging::init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    match cli::parse(&args) {
        ParsedCli::Help => {
            println!("{}", cli::help_text());
            ProcessExitCode::SUCCESS
        }
        ParsedCli::Version => {
            println!("{}", installer_services::manifest::product().version);
            ProcessExitCode::SUCCESS
        }
        ParsedCli::Error(msg) => {
            eprintln!("error: {msg}\n\n{}", cli::help_text());
            ProcessExitCode::from(cli::ExitCode::InvalidCommandLine.as_i32() as u8)
        }
        ParsedCli::Run(cmd) if cmd.is_headless() => {
            let code = app::cli::execute(&cmd);
            tracing::info!(code = code.as_i32(), "headless command finished");
            // Process exit codes are a byte; the well-known Windows codes
            // (3010, 1602, …) exceed that, so we log the full code and return
            // its low byte for the shell while the log carries the precise
            // value.
            ProcessExitCode::from(code.as_i32() as u8)
        }
        ParsedCli::Run(_) => {
            // GUI / interactive (including an interactive --uninstall/--modify
            // from the Add/Remove Programs buttons, and the --resume handoff).
            run_gui();
            ProcessExitCode::SUCCESS
        }
    }
}

/// Build and run the interactive setup wizard window.
fn run_gui() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app::state::AppState::new())
        .setup(|app| {
            // The wizard is a single frameless, transparent window; the
            // frontend paints its own chrome (title bar + rounded shell).
            let mut builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Clippity Setup")
                    .inner_size(900.0, 620.0)
                    .min_inner_size(820.0, 560.0)
                    .resizable(true)
                    .center()
                    .decorations(false)
                    .transparent(true)
                    .shadow(false);

            // Pin the WebView2 cache under the product's single data root
            // (`%LOCALAPPDATA%\Clippity\installer`) instead of Tauri's
            // default `%LOCALAPPDATA%\com.clippity.installer`. Keeps the
            // wizard's throwaway browser cache inside the one Clippity
            // folder rather than leaving a stray reverse-DNS directory.
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                let dir = std::path::PathBuf::from(local)
                    .join("Clippity")
                    .join("installer");
                builder = builder.data_directory(dir);
            }

            builder.build()?;

            tracing::info!("clippity setup ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app::commands::ping,
            app::commands::get_product,
            app::commands::get_components,
            app::commands::get_data_categories,
            app::commands::get_install_status,
            app::commands::detect_installation,
            app::commands::resolve_plan,
            app::commands::get_installed_configuration,
            app::commands::check_updates,
            app::commands::assess_repair,
            app::commands::check_recovery,
            app::commands::removal_summary,
            app::commands::is_elevated,
            app::commands::plan_requires_elevation,
            app::commands::elevate_and_install,
            app::commands::take_pending_plan,
            app::commands::get_launch_route,
            app::commands::uninstall_requires_elevation,
            app::commands::elevate_and_uninstall,
            app::commands::take_pending_removal,
            app::commands::maintenance_paths,
            app::commands::launch_app,
            app::commands::run_install,
            app::commands::run_modify,
            app::commands::run_repair,
            app::commands::run_update,
            app::commands::run_uninstall,
        ])
        .run(tauri::generate_context!())
        .expect("error while running clippity setup");
}
