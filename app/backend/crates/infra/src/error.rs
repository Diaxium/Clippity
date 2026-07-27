//! Unified error type.
//!
//! Tauri commands return `AppResult<T>` which serializes the error as
//! `{ "code": "…", "message": "…" }` for the frontend. Each variant
//! maps to a stable string code so the UI can branch on `code`
//! without parsing free-form messages.

use serde::Serialize;
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("tauri error: {0}")]
    Tauri(#[from] tauri::Error),

    #[error("capture failed: {0}")]
    Capture(String),

    #[error("overlay error: {0}")]
    Overlay(String),

    #[error("toast error: {0}")]
    Toast(String),

    #[error("library error: {0}")]
    Library(String),

    #[error("editor error: {0}")]
    Editor(String),

    #[error("settings error: {0}")]
    Settings(String),

    #[error("countdown error: {0}")]
    Countdown(String),

    #[error("tray error: {0}")]
    Tray(String),

    #[error("presets error: {0}")]
    Presets(String),

    #[error("vision error: {0}")]
    Vision(String),

    #[error("model error: {0}")]
    Models(String),

    #[error("ocr error: {0}")]
    Ocr(String),

    #[error("share failed: {0}")]
    Share(String),

    /// Screen recording — capture source, encoder or muxer. Separate
    /// from `Capture` because the UI branches on it: a still capture
    /// that fails can simply be retaken, while a recording failure has
    /// to explain what happened to the partial file.
    #[error("recording failed: {0}")]
    Recorder(String),

    #[error("unsupported on this platform: {0}")]
    Unsupported(&'static str),

    /// The feature exists in this build but was **declined at install
    /// time** (see `domain::provisioning`). Distinct from `Unsupported`,
    /// which means the platform or the port cannot do it at all: this one
    /// is fixable, by running the installer's Modify flow and re-selecting
    /// the component. The UI branches on the code to say so.
    #[error("this feature was not installed: {0}")]
    NotInstalled(&'static str),
}

impl AppError {
    /// Stable error code surfaced to the frontend. Add a new arm when
    /// adding a variant; the UI keys off this string.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Io(_) => "io",
            AppError::Serialization(_) => "serialization",
            AppError::Tauri(_) => "tauri",
            AppError::Capture(_) => "capture",
            AppError::Overlay(_) => "overlay",
            AppError::Toast(_) => "toast",
            AppError::Library(_) => "library",
            AppError::Editor(_) => "editor",
            AppError::Settings(_) => "settings",
            AppError::Countdown(_) => "countdown",
            AppError::Tray(_) => "tray",
            AppError::Presets(_) => "presets",
            AppError::Vision(_) => "vision",
            AppError::Models(_) => "models",
            AppError::Ocr(_) => "ocr",
            AppError::Share(_) => "share",
            AppError::Recorder(_) => "recorder",
            AppError::Unsupported(_) => "unsupported",
            AppError::NotInstalled(_) => "not-installed",
        }
    }
}

#[derive(Serialize)]
struct WireError<'a> {
    code: &'a str,
    message: String,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        WireError {
            code: self.code(),
            message: self.to_string(),
        }
        .serialize(s)
    }
}
