//! The command-line interface — pure parsing and the stable exit-code
//! table.
//!
//! The wizard is normally launched by double-click with no arguments, in
//! which case it opens the interactive GUI. But it is also the target of
//! the Add/Remove Programs Uninstall / Modify buttons and of unattended
//! deployment, so it accepts an explicit command interface:
//!
//! ```text
//!   ClippityWizard.exe --install   [--silent] [--scope user|machine]
//!                                   [--install-dir <path>] [--components a,b,c]
//!   ClippityWizard.exe --repair    [--silent]
//!   ClippityWizard.exe --update    [--silent] [--no-restart]
//!   ClippityWizard.exe --modify    [--components a,b,c]
//!   ClippityWizard.exe --uninstall [--silent] [--keep-user-data] [--remove-settings]
//! ```
//!
//! Parsing is pure and testable here; the process wiring (choose GUI vs
//! headless, run the operation, translate the result into an exit code)
//! lives in the `src-tauri` layer. Silent mode must never surface an
//! interactive prompt, so a request that cannot be satisfied non-
//! interactively is a parse error rather than a hang.

use serde::{Deserialize, Serialize};

use crate::install::InstallScope;

/// Which maintenance operation the command line asks for. `Gui` is the
/// no-mode-flag default — open the interactive wizard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CliMode {
    Gui,
    Install,
    Modify,
    Repair,
    Update,
    Reinstall,
    Uninstall,
}

impl CliMode {
    /// Whether this mode mutates the system (so headless execution needs the
    /// single-operation guard and a journal).
    pub fn is_mutating(self) -> bool {
        !matches!(self, CliMode::Gui)
    }
}

/// How much UI a command is allowed to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verbosity {
    /// Full interactive wizard (the default).
    Interactive,
    /// A progress window but no prompts.
    Passive,
    /// No UI at all; drive from the command line and report via exit code.
    Silent,
}

/// A fully-parsed command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliCommand {
    pub mode: CliMode,
    pub verbosity: Verbosity,
    pub scope: Option<InstallScope>,
    pub install_dir: Option<String>,
    pub components: Option<Vec<String>>,
    /// Keep all user data on uninstall (only remove application files).
    pub keep_user_data: bool,
    /// Also remove settings/preferences on uninstall.
    pub remove_settings: bool,
    pub log_path: Option<String>,
    /// Do not relaunch the app after an update.
    pub no_restart: bool,
}

impl CliCommand {
    /// The default GUI command (no arguments).
    pub fn gui() -> Self {
        Self {
            mode: CliMode::Gui,
            verbosity: Verbosity::Interactive,
            scope: None,
            install_dir: None,
            components: None,
            keep_user_data: false,
            remove_settings: false,
            log_path: None,
            no_restart: false,
        }
    }

    /// Whether the command runs without any window (silent).
    pub fn is_headless(&self) -> bool {
        self.mode.is_mutating() && self.verbosity == Verbosity::Silent
    }
}

/// The result of parsing a command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedCli {
    /// Run this command.
    Run(CliCommand),
    /// Print help and exit successfully.
    Help,
    /// Print the version and exit successfully.
    Version,
    /// The command line was invalid; carries a human-readable reason.
    Error(String),
}

/// Parse arguments (excluding the program name) into a [`ParsedCli`].
///
/// Unknown flags and conflicting modes are rejected rather than ignored, so
/// a mistyped silent-deployment command fails loudly with
/// [`ExitCode::InvalidCommandLine`] instead of silently doing the wrong
/// thing.
pub fn parse(args: &[String]) -> ParsedCli {
    let mut cmd = CliCommand::gui();
    let mut mode_set = false;
    let mut i = 0;

    // A value-taking flag helper: returns the next arg or an error.
    macro_rules! value {
        ($flag:expr) => {{
            i += 1;
            match args.get(i) {
                Some(v) => v.clone(),
                None => return ParsedCli::Error(format!("{} requires a value", $flag)),
            }
        }};
    }

    // Set the mode, rejecting a second, conflicting mode flag.
    macro_rules! set_mode {
        ($m:expr, $flag:expr) => {{
            if mode_set && cmd.mode != $m {
                return ParsedCli::Error(format!(
                    "conflicting modes: {:?} and {}",
                    cmd.mode, $flag
                ));
            }
            cmd.mode = $m;
            mode_set = true;
        }};
    }

    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "--help" | "-h" | "/?" => return ParsedCli::Help,
            "--version" | "-v" => return ParsedCli::Version,

            "--install" => set_mode!(CliMode::Install, arg),
            "--modify" => set_mode!(CliMode::Modify, arg),
            "--repair" => set_mode!(CliMode::Repair, arg),
            "--update" => set_mode!(CliMode::Update, arg),
            "--reinstall" => set_mode!(CliMode::Reinstall, arg),
            "--uninstall" | "--remove" => set_mode!(CliMode::Uninstall, arg),

            "--silent" | "-s" | "/S" => cmd.verbosity = Verbosity::Silent,
            "--passive" => cmd.verbosity = Verbosity::Passive,

            "--scope" => {
                let v = value!("--scope");
                cmd.scope = Some(match v.to_lowercase().as_str() {
                    "user" | "current-user" | "currentuser" => InstallScope::CurrentUser,
                    "machine" | "all-users" | "allusers" | "system" => InstallScope::AllUsers,
                    other => return ParsedCli::Error(format!("unknown scope: {other}")),
                });
            }
            "--install-dir" | "--dir" => cmd.install_dir = Some(value!("--install-dir")),
            "--components" => {
                let v = value!("--components");
                let list: Vec<String> = v
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                cmd.components = Some(list);
            }
            "--keep-user-data" => cmd.keep_user_data = true,
            "--remove-settings" => cmd.remove_settings = true,
            "--log" => cmd.log_path = Some(value!("--log")),
            "--no-restart" => cmd.no_restart = true,

            // The elevation handoffs are consumed elsewhere (they always mean
            // "resume a GUI install / uninstall"); tolerate them and their
            // value here so they are not treated as unknown flags.
            "--resume" | "--resume-uninstall" => {
                i += 1; // skip the handoff path
            }

            other => {
                return ParsedCli::Error(format!("unknown argument: {other}"));
            }
        }
        i += 1;
    }

    // Silent mode with no mode flag has nothing to do — reject rather than
    // open a window the caller did not expect.
    if cmd.verbosity == Verbosity::Silent && !mode_set {
        return ParsedCli::Error("--silent requires an operation (e.g. --uninstall)".into());
    }

    ParsedCli::Run(cmd)
}

/// Stable process exit codes. The well-known values reuse the Windows
/// Installer codes deployment tooling already understands
/// (`ERROR_SUCCESS_REBOOT_REQUIRED = 3010`, `ERROR_INSTALL_USEREXIT = 1602`,
/// …); the engine-specific outcomes use a private 200-block so they never
/// collide with a system code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum ExitCode {
    Success = 0,
    /// Completed, but a reboot is required to finish (locked files).
    SuccessRebootRequired = 3010,
    /// The user cancelled the operation.
    UserCancelled = 1602,
    /// The user declined the UAC elevation prompt.
    UacCancelled = 1223,
    /// The command line was invalid.
    InvalidCommandLine = 1639,
    /// Another maintenance operation is already running.
    AlreadyRunning = 1618,
    /// A fatal, uncategorised failure.
    GeneralFailure = 1603,

    // ---- Clippity engine-specific (private 200-block) ----
    /// Requested an install but the product is already installed.
    AlreadyInstalled = 200,
    /// The same version is already installed.
    SameVersionInstalled = 201,
    /// A newer version is already installed.
    NewerVersionInstalled = 202,
    /// Refused an unsupported downgrade.
    UnsupportedDowngrade = 203,
    /// The package failed identity/hash verification.
    InvalidPackage = 204,
    /// The package failed signature verification.
    SignatureFailure = 205,
    /// Not enough disk space.
    InsufficientDiskSpace = 206,
    /// Files are in use and could not be replaced.
    FilesInUse = 207,
    /// The operation failed and was rolled back successfully.
    RollbackCompleted = 208,
    /// The operation failed and the rollback also failed.
    RollbackFailed = 209,
    /// Completed, but some cleanup could not finish.
    PartialCleanup = 210,
    /// A maintenance operation was requested but nothing is installed.
    NotInstalled = 211,
}

impl ExitCode {
    /// The integer the process exits with.
    pub fn as_i32(self) -> i32 {
        self as i32
    }

    /// Whether this code indicates overall success (including the
    /// reboot-required and partial-cleanup "succeeded with a caveat" cases).
    pub fn is_success(self) -> bool {
        matches!(
            self,
            ExitCode::Success | ExitCode::SuccessRebootRequired | ExitCode::PartialCleanup
        )
    }
}

/// The `--help` text, kept next to the parser so the two never drift.
pub fn help_text() -> &'static str {
    "Clippity Wizard — Windows setup & maintenance\n\
     \n\
     USAGE:\n    \
     ClippityWizard.exe [MODE] [OPTIONS]\n\
     \n\
     MODES (default: open the interactive wizard):\n    \
     --install        Install Clippity\n    \
     --modify         Add or remove components\n    \
     --repair         Restore a damaged installation\n    \
     --update         Update to the bundled version\n    \
     --reinstall      Reinstall over the current version\n    \
     --uninstall      Remove Clippity\n\
     \n\
     OPTIONS:\n    \
     --silent             No UI; report via exit code\n    \
     --passive            Progress only; no prompts\n    \
     --scope <user|machine>   Install scope\n    \
     --install-dir <path>     Installation directory\n    \
     --components <a,b,c>     Component ids to select\n    \
     --keep-user-data     Keep all user data on uninstall\n    \
     --remove-settings    Also remove settings on uninstall\n    \
     --log <path>         Write the operation log here\n    \
     --no-restart         Do not relaunch after update\n    \
     -h, --help           Show this help\n    \
     -v, --version        Show the version"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    fn run(s: &[&str]) -> CliCommand {
        match parse(&args(s)) {
            ParsedCli::Run(c) => c,
            other => panic!("expected Run, got {other:?}"),
        }
    }

    #[test]
    fn no_args_is_the_interactive_gui() {
        let c = run(&[]);
        assert_eq!(c.mode, CliMode::Gui);
        assert_eq!(c.verbosity, Verbosity::Interactive);
        assert!(!c.is_headless());
    }

    #[test]
    fn silent_uninstall_is_headless() {
        let c = run(&["--uninstall", "--silent"]);
        assert_eq!(c.mode, CliMode::Uninstall);
        assert_eq!(c.verbosity, Verbosity::Silent);
        assert!(c.is_headless());
    }

    #[test]
    fn install_options_parse() {
        let c = run(&[
            "--install",
            "--scope",
            "machine",
            "--install-dir",
            r"D:\Apps\Clippity",
            "--components",
            "core, gif ,ocr",
        ]);
        assert_eq!(c.mode, CliMode::Install);
        assert_eq!(c.scope, Some(InstallScope::AllUsers));
        assert_eq!(c.install_dir.as_deref(), Some(r"D:\Apps\Clippity"));
        assert_eq!(
            c.components,
            Some(vec!["core".into(), "gif".into(), "ocr".into()])
        );
    }

    #[test]
    fn scope_aliases_resolve() {
        assert_eq!(run(&["--install", "--scope", "user"]).scope, Some(InstallScope::CurrentUser));
        assert_eq!(run(&["--install", "--scope", "all-users"]).scope, Some(InstallScope::AllUsers));
    }

    #[test]
    fn help_and_version_short_circuit() {
        assert_eq!(parse(&args(&["--help"])), ParsedCli::Help);
        assert_eq!(parse(&args(&["-h"])), ParsedCli::Help);
        assert_eq!(parse(&args(&["--version"])), ParsedCli::Version);
    }

    #[test]
    fn unknown_flag_is_an_error() {
        assert!(matches!(parse(&args(&["--frobnicate"])), ParsedCli::Error(_)));
    }

    #[test]
    fn conflicting_modes_are_rejected() {
        assert!(matches!(
            parse(&args(&["--install", "--uninstall"])),
            ParsedCli::Error(_)
        ));
    }

    #[test]
    fn repeating_the_same_mode_is_fine() {
        // Idempotent: two --uninstall is not a conflict.
        let c = run(&["--uninstall", "--uninstall"]);
        assert_eq!(c.mode, CliMode::Uninstall);
    }

    #[test]
    fn silent_without_a_mode_is_rejected() {
        assert!(matches!(parse(&args(&["--silent"])), ParsedCli::Error(_)));
    }

    #[test]
    fn value_flag_missing_its_value_errors() {
        assert!(matches!(parse(&args(&["--install", "--scope"])), ParsedCli::Error(_)));
        assert!(matches!(parse(&args(&["--install-dir"])), ParsedCli::Error(_)));
    }

    #[test]
    fn unknown_scope_is_rejected() {
        assert!(matches!(
            parse(&args(&["--install", "--scope", "sideways"])),
            ParsedCli::Error(_)
        ));
    }

    #[test]
    fn resume_handoff_is_tolerated_as_gui() {
        // The elevation handoff must not be treated as an unknown flag.
        let c = run(&["--resume", r"C:\Temp\handoff.json"]);
        assert_eq!(c.mode, CliMode::Gui);
    }

    #[test]
    fn resume_uninstall_handoff_is_tolerated_as_gui() {
        // The uninstall elevation handoff is likewise resumed as a GUI run.
        let c = run(&["--resume-uninstall", r"C:\Temp\uninstall-handoff.json"]);
        assert_eq!(c.mode, CliMode::Gui);
    }

    #[test]
    fn uninstall_data_flags_parse() {
        let c = run(&["--uninstall", "--silent", "--keep-user-data", "--remove-settings"]);
        assert!(c.keep_user_data);
        assert!(c.remove_settings);
    }

    #[test]
    fn exit_codes_are_stable_and_classified() {
        assert_eq!(ExitCode::Success.as_i32(), 0);
        assert_eq!(ExitCode::SuccessRebootRequired.as_i32(), 3010);
        assert_eq!(ExitCode::UserCancelled.as_i32(), 1602);
        assert_eq!(ExitCode::InvalidCommandLine.as_i32(), 1639);
        assert!(ExitCode::Success.is_success());
        assert!(ExitCode::SuccessRebootRequired.is_success());
        assert!(!ExitCode::GeneralFailure.is_success());
        assert!(!ExitCode::UnsupportedDowngrade.is_success());
    }
}
