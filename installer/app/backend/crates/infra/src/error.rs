//! The one error type the installer surfaces to the Tauri layer.

use std::fmt;

/// Result alias used throughout the workspace.
pub type InstallerResult<T> = Result<T, InstallerError>;

/// A flat, serializable error. Every fallible service maps its failure
/// modes onto one of these variants so the frontend can render a
/// consistent message and the log carries a stable code.
#[derive(Debug, thiserror::Error)]
pub enum InstallerError {
    /// A filesystem operation failed (copy, remove, create dir).
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),

    /// The requested operation needs elevation the process doesn't have.
    #[error("this action requires administrator privileges")]
    ElevationRequired,

    /// A downloaded package failed signature verification.
    #[error("update package failed signature verification")]
    SignatureInvalid,

    /// A domain rule rejected the request (bad plan, empty selection…).
    #[error("invalid request: {0}")]
    Invalid(String),

    /// Anything else, carrying a human-readable message.
    #[error("{0}")]
    Other(String),
}

impl InstallerError {
    /// A short, stable machine code for logs and the frontend.
    pub fn code(&self) -> &'static str {
        match self {
            InstallerError::Io(_) => "io",
            InstallerError::ElevationRequired => "elevation-required",
            InstallerError::SignatureInvalid => "signature-invalid",
            InstallerError::Invalid(_) => "invalid",
            InstallerError::Other(_) => "other",
        }
    }
}

/// Serialize as a plain string so `tauri::command` results carry the
/// human-readable message straight to the frontend.
impl serde::Serialize for InstallerError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Convenience for building an [`InstallerError::Other`] from anything
/// `Display`.
pub fn other(msg: impl fmt::Display) -> InstallerError {
    InstallerError::Other(msg.to_string())
}
