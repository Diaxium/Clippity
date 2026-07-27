//! Read the installer's handoff document and resolve this installation's
//! [`Capabilities`].
//!
//! The document lives *beside the executable*, not under the app data root:
//! it describes the installation, so it belongs with the installed files,
//! and locating it needs nothing but `current_exe()` — no registry lookup,
//! no knowledge of the installer's maintenance directory, no dependency on
//! paths that differ between per-user and all-users installs.
//!
//! Read **once at startup** and cached for the process. Deliberately not
//! live-reloaded: the file only changes when the installer's Modify or
//! Repair runs, and both require closing Clippity first (the installer stops
//! running processes before touching the install directory). Re-reading it
//! per query would buy nothing and would mean a feature could disappear
//! mid-session.
//!
//! Every failure path resolves to [`Capabilities::unmanaged`] — everything
//! available. See `domain::provisioning` for why silence must not read as
//! "the user declined everything".

use std::path::{Path, PathBuf};

use clippity_domain::provisioning::{Capabilities, InstallProvisioning, PROVISIONING_FILE};

/// Where the document was found — logged at startup and surfaced to the
/// frontend so "unmanaged" can be explained rather than just asserted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProvisioningSource {
    /// A usable document was read beside the executable.
    Installer,
    /// Portable mode — there is no installer to have asked anything.
    Portable,
    /// No document beside the executable (a development run, or a copy
    /// extracted by hand).
    Absent,
    /// A document was present but unreadable, unparseable, or written by a
    /// newer installer than this build understands.
    Unusable,
}

impl ProvisioningSource {
    /// A short, stable tag for logs and the IPC payload.
    pub fn as_str(self) -> &'static str {
        match self {
            ProvisioningSource::Installer => "installer",
            ProvisioningSource::Portable => "portable",
            ProvisioningSource::Absent => "absent",
            ProvisioningSource::Unusable => "unusable",
        }
    }
}

/// The resolved installation profile for this process.
pub struct ProvisioningService {
    capabilities: Capabilities,
    source: ProvisioningSource,
    document: Option<InstallProvisioning>,
}

impl ProvisioningService {
    /// Resolve the profile for the running executable.
    ///
    /// Infallible by construction: anything that goes wrong is logged and
    /// resolves to [`Capabilities::unmanaged`], because an app that refuses
    /// to start because a configuration file is malformed is a worse
    /// outcome than one that offers a feature the user declined.
    pub fn resolve() -> Self {
        // Portable mode is answered before touching the disk: the marker
        // beside the exe means this copy was never installed, so a stray
        // document next to it (a leftover from the folder it was copied
        // from, say) has no authority over it.
        if clippity_infra::paths::portable_root().is_some() {
            tracing::info!("provisioning: portable build — every feature enabled");
            return Self::without_document(ProvisioningSource::Portable);
        }

        let Some(path) = document_path() else {
            tracing::debug!("provisioning: cannot locate the executable directory");
            return Self::without_document(ProvisioningSource::Absent);
        };

        Self::from_path(&path)
    }

    /// Resolve from an explicit document path — the seam the tests drive
    /// (including `settings_service`'s first-launch seeding tests, which
    /// need a service built around a document they wrote themselves).
    pub(crate) fn from_path(path: &Path) -> Self {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // The normal case for a development run: no installer wrote
                // one, so there is nothing to honor.
                tracing::debug!(
                    path = %path.display(),
                    "provisioning: no installer configuration — every feature enabled"
                );
                return Self::without_document(ProvisioningSource::Absent);
            }
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "provisioning: configuration unreadable — every feature enabled"
                );
                return Self::without_document(ProvisioningSource::Unusable);
            }
        };

        let document: InstallProvisioning = match serde_json::from_str(&raw) {
            Ok(doc) => doc,
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "provisioning: configuration is malformed — every feature enabled"
                );
                return Self::without_document(ProvisioningSource::Unusable);
            }
        };

        if !document.is_usable() {
            tracing::warn!(
                path = %path.display(),
                schema = document.schema_version,
                product = %document.product_id,
                "provisioning: configuration is not one this build can apply \
                 — every feature enabled"
            );
            return Self::without_document(ProvisioningSource::Unusable);
        }

        let capabilities = Capabilities::from_provisioning(&document);
        tracing::info!(
            components = ?document.components,
            hotkeys = capabilities.global_hotkeys,
            ocr = capabilities.text_recognition,
            gif = capabilities.gif_recording,
            "provisioning: applying the installer's choices"
        );
        Self {
            capabilities,
            source: ProvisioningSource::Installer,
            document: Some(document),
        }
    }

    /// The "no answers to honor" profile.
    fn without_document(source: ProvisioningSource) -> Self {
        Self {
            capabilities: Capabilities::unmanaged(),
            source,
            document: None,
        }
    }

    /// What this installation may offer. Cheap — `Capabilities` is `Copy`.
    pub fn capabilities(&self) -> Capabilities {
        self.capabilities
    }

    /// Where the profile came from.
    pub fn source(&self) -> ProvisioningSource {
        self.source
    }

    /// The document itself, when one was applied. Used for first-run
    /// settings seeding, which needs the *preferences* rather than the
    /// capability flags.
    pub fn document(&self) -> Option<&InstallProvisioning> {
        self.document.as_ref()
    }
}

/// Absolute path of the handoff document beside the running executable.
///
/// `None` only when the executable's own location cannot be determined,
/// which in practice means a platform or permission oddity rather than
/// anything about how Clippity was installed.
pub fn document_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(PROVISIONING_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("clippity-provisioning-svc-{tag}-{n}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// Write `body` as the document in a fresh directory and resolve it.
    fn resolve_document(tag: &str, body: &str) -> ProvisioningService {
        let dir = scratch(tag);
        let path = dir.join(PROVISIONING_FILE);
        fs::write(&path, body).expect("write document");
        ProvisioningService::from_path(&path)
    }

    const FULL: &str = r#"{
        "schemaVersion": 1,
        "productId": "com.clippity.app",
        "version": "1.5.0",
        "writtenAt": "2026-07-25T10:00:00Z",
        "scope": "current-user",
        "components": ["core", "capture", "assoc", "startup", "gif", "ocr", "cloud"],
        "preferences": {
            "desktopShortcut": true,
            "startAtLogin": true,
            "automaticUpdates": false,
            "helpImprove": false,
            "fileAssociations": true
        }
    }"#;

    #[test]
    fn a_real_document_is_applied() {
        let svc = resolve_document("full", FULL);
        assert_eq!(svc.source(), ProvisioningSource::Installer);
        let caps = svc.capabilities();
        assert!(!caps.unmanaged);
        assert!(caps.text_recognition);
        assert!(!caps.automatic_updates, "the user turned updates off");
        assert!(!caps.usage_reporting);
        // The document is kept for first-run settings seeding.
        assert!(svc.document().expect("document").preferences.start_at_login);
    }

    #[test]
    fn declined_components_gate_their_features() {
        let svc = resolve_document(
            "partial",
            r#"{ "schemaVersion": 1, "components": ["core", "capture"] }"#,
        );
        let caps = svc.capabilities();
        assert!(caps.global_hotkeys);
        assert!(!caps.text_recognition);
        assert!(!caps.gif_recording);
    }

    #[test]
    fn a_missing_document_enables_everything() {
        let dir = scratch("missing");
        let svc = ProvisioningService::from_path(&dir.join(PROVISIONING_FILE));
        assert_eq!(svc.source(), ProvisioningSource::Absent);
        assert!(svc.capabilities().unmanaged);
        assert!(svc.capabilities().text_recognition);
        assert!(svc.document().is_none());
    }

    #[test]
    fn a_malformed_document_enables_everything() {
        // A truncated write must not cost the user their features.
        let svc = resolve_document("malformed", r#"{ "schemaVersion": 1, "compo"#);
        assert_eq!(svc.source(), ProvisioningSource::Unusable);
        assert!(svc.capabilities().unmanaged);
        assert!(svc.capabilities().gif_recording);
    }

    #[test]
    fn a_document_from_a_newer_installer_enables_everything() {
        let svc = resolve_document(
            "newer",
            r#"{ "schemaVersion": 99, "components": ["core"] }"#,
        );
        assert_eq!(svc.source(), ProvisioningSource::Unusable);
        assert!(svc.capabilities().unmanaged);
        assert!(svc.capabilities().global_hotkeys);
    }

    #[test]
    fn a_document_for_another_product_is_ignored() {
        let svc = resolve_document(
            "foreign",
            r#"{ "schemaVersion": 1, "productId": "com.example.other", "components": ["core"] }"#,
        );
        assert_eq!(svc.source(), ProvisioningSource::Unusable);
        assert!(svc.capabilities().unmanaged);
    }

    #[test]
    fn source_tags_are_stable() {
        // They cross the IPC boundary, so the frontend depends on them.
        assert_eq!(ProvisioningSource::Installer.as_str(), "installer");
        assert_eq!(ProvisioningSource::Portable.as_str(), "portable");
        assert_eq!(ProvisioningSource::Absent.as_str(), "absent");
        assert_eq!(ProvisioningSource::Unusable.as_str(), "unusable");
    }

    #[test]
    fn the_document_sits_beside_the_executable() {
        let path = document_path().expect("exe path resolves");
        assert_eq!(path.file_name().unwrap(), PROVISIONING_FILE);
        assert_eq!(
            path.parent().unwrap(),
            std::env::current_exe().unwrap().parent().unwrap()
        );
    }
}
