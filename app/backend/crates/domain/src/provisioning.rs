//! What the installer was told to install — and the feature availability
//! that follows from it. **Pure. No I/O.**
//!
//! The Clippity installer's Options and Components steps let a user decline
//! things: no global capture hotkey, no OCR engine, no GIF encoder, no
//! automatic updates. Those answers used to die with the wizard process —
//! the app shipped every feature regardless, so a user who unchecked "OCR
//! engine" still found Grab Text on the Custom panel, and unchecking
//! "Enable automatic updates" bound to nothing at all.
//!
//! The installer now writes its answers into a small versioned document
//! beside the installed executable ([`PROVISIONING_FILE`]), and this module
//! is the app's reader for it plus the rules that turn it into
//! [`Capabilities`] — the set of features this installation is allowed to
//! offer. `services::provisioning_service` performs the read; everything
//! interesting about *interpreting* it is here, so it can be tested without
//! a filesystem.
//!
//! **The absent case is "everything on", never "everything off."** A
//! portable build, a `cargo run` during development, a copy someone
//! extracted by hand, and a document a disk error truncated all have no
//! installer answers to honor. Reading silence as "the user declined
//! everything" would break each of those; reading it as "nothing was
//! declined" only loses the ability to hide features, which is the strictly
//! safer failure. The same reasoning covers a document from a *newer*
//! installer: fields this build cannot interpret must not silently disable
//! the features they describe.

use serde::{Deserialize, Serialize};

/// File name the installer writes beside `Clippity.exe`.
///
/// Resolved as `current_exe().parent().join(…)`, so the name is load-bearing
/// on both sides — it must match `installer_domain::provisioning::PROVISIONING_FILE`.
pub const PROVISIONING_FILE: &str = "install-config.json";

/// Highest document schema this build understands.
///
/// A document above this is ignored wholesale (with a warning) rather than
/// partially applied — see the module note on the absent case.
pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// Product id a document must carry to be ours. Guards against acting on a
/// same-named file that belongs to something else entirely.
pub const PRODUCT_ID: &str = "com.clippity.app";

// ---------------------------------------------------------------------------
// Component ids
// ---------------------------------------------------------------------------

/// Component ids the installer's catalog offers. Only the ones the app can
/// actually act on are named here; an id the app doesn't know about is
/// simply carried in [`InstallProvisioning::components`] and ignored.
pub mod components {
    /// The application itself — always installed, never declinable.
    pub const CORE: &str = "core";
    /// OS-global capture hotkeys.
    pub const CAPTURE: &str = "capture";
    /// File-type associations.
    pub const ASSOC: &str = "assoc";
    /// Start-with-Windows helper.
    pub const STARTUP: &str = "startup";
    /// GIF encoding for screen recordings.
    pub const GIF: &str = "gif";
    /// On-device text recognition (Grab Text).
    pub const OCR: &str = "ocr";
    /// Cross-device sync.
    pub const CLOUD: &str = "cloud";
}

/// Which Windows account the install targeted. Carried for diagnostics —
/// nothing in the app branches on it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InstallScope {
    CurrentUser,
    AllUsers,
}

/// The install-time preferences the app should reflect.
///
/// Every field is `#[serde(default = …)]` with the value the installer
/// itself defaults to, so a document written by a build that knew fewer
/// fields reads as "the user accepted the defaults for the rest" — which is
/// what actually happened.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionedPreferences {
    #[serde(default = "yes")]
    pub desktop_shortcut: bool,
    /// Whether the installer registered Clippity to start with Windows.
    /// Seeds `settings.general.start_on_startup` on first launch.
    #[serde(default)]
    pub start_at_login: bool,
    #[serde(default = "yes")]
    pub automatic_updates: bool,
    #[serde(default = "yes")]
    pub help_improve: bool,
    #[serde(default = "yes")]
    pub file_associations: bool,
}

/// `#[serde(default)]` for a flag the installer ships **on** — bare
/// `default` would give `false`, inverting the user's choice.
fn yes() -> bool {
    true
}

impl Default for ProvisionedPreferences {
    fn default() -> Self {
        Self {
            desktop_shortcut: true,
            start_at_login: false,
            automatic_updates: true,
            help_improve: true,
            file_associations: true,
        }
    }
}

/// The installer's handoff document, as read off disk.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallProvisioning {
    pub schema_version: u32,
    #[serde(default)]
    pub product_id: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub written_at: String,
    #[serde(default = "current_user")]
    pub scope: InstallScope,
    /// Component ids the user kept. An empty list is treated as "no
    /// component information", not "nothing installed" — see
    /// [`Capabilities::from_provisioning`].
    #[serde(default)]
    pub components: Vec<String>,
    #[serde(default)]
    pub preferences: ProvisionedPreferences,
}

fn current_user() -> InstallScope {
    InstallScope::CurrentUser
}

impl InstallProvisioning {
    /// Whether this document is one this build should act on.
    ///
    /// Rejects a foreign product id and a schema newer than
    /// [`SUPPORTED_SCHEMA_VERSION`]. A blank product id passes: the field is
    /// `#[serde(default)]`, so requiring it would reject a document from a
    /// future installer that dropped it, and the file's location beside our
    /// own executable is already strong evidence of ownership.
    pub fn is_usable(&self) -> bool {
        self.schema_version <= SUPPORTED_SCHEMA_VERSION
            && (self.product_id.is_empty() || self.product_id == PRODUCT_ID)
    }

    /// Whether `id` was installed.
    pub fn has_component(&self, id: &str) -> bool {
        self.components.iter().any(|c| c == id)
    }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/// What this installation is allowed to offer.
///
/// Named per feature rather than exposing the raw component list, so a
/// caller asks "may I record a GIF?" instead of re-deriving the mapping from
/// component ids at each site. Every flag is *permission*, not preference:
/// a `false` here means the feature should be absent from the UI and refused
/// by the backend, whereas a settings toggle means the user turned something
/// off and can turn it back on.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// OS-global capture hotkey may be registered (component `capture`).
    pub global_hotkeys: bool,
    /// Grab Text / OCR may run (component `ocr`).
    pub text_recognition: bool,
    /// Recordings may be encoded as GIF (component `gif`).
    pub gif_recording: bool,
    /// Clippity may register itself to start with Windows (component
    /// `startup`).
    pub start_at_login: bool,
    /// Clippity is a registered handler for supported file types
    /// (component `assoc` **and** the file-associations preference).
    pub file_associations: bool,
    /// Cross-device sync (component `cloud`). No feature consumes this yet;
    /// it is resolved now so the day one lands it is already gated.
    pub cloud_sync: bool,
    /// The user left automatic updates on.
    pub automatic_updates: bool,
    /// The user agreed to share anonymous usage data.
    pub usage_reporting: bool,
    /// True when no installer document was found (or it was unusable) and
    /// every flag above is therefore an assumption rather than the user's
    /// answer. Drives the "unmanaged" wording in the UI and keeps the app
    /// from claiming the user chose something they never saw.
    pub unmanaged: bool,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self::unmanaged()
    }
}

impl Capabilities {
    /// Everything available, flagged as not coming from an installer.
    ///
    /// The answer for a portable build, a development run, and any
    /// unreadable document.
    pub fn unmanaged() -> Self {
        Self {
            global_hotkeys: true,
            text_recognition: true,
            gif_recording: true,
            start_at_login: true,
            file_associations: true,
            cloud_sync: true,
            automatic_updates: true,
            usage_reporting: true,
            unmanaged: true,
        }
    }

    /// Resolve capabilities from a document the app decided to trust.
    ///
    /// A document with an **empty** component list resolves every
    /// component-backed flag to `true`: an installer that recorded no
    /// components told us nothing about them, and the only way to record
    /// zero components is a broken manifest — `core` is not declinable. The
    /// preference-backed flags are still honored, because those are recorded
    /// independently of the list.
    pub fn from_provisioning(doc: &InstallProvisioning) -> Self {
        let no_component_info = doc.components.is_empty();
        let has = |id: &str| no_component_info || doc.has_component(id);
        let prefs = doc.preferences;
        Self {
            global_hotkeys: has(components::CAPTURE),
            text_recognition: has(components::OCR),
            gif_recording: has(components::GIF),
            start_at_login: has(components::STARTUP),
            // Both halves matter: the component is the handler registration,
            // the preference is whether the user wanted it used.
            file_associations: has(components::ASSOC) && prefs.file_associations,
            cloud_sync: has(components::CLOUD),
            automatic_updates: prefs.automatic_updates,
            usage_reporting: prefs.help_improve,
            unmanaged: false,
        }
    }

    /// Capabilities for an optional document — the shape the service layer
    /// actually has. `None` (absent / unreadable / too new) and an unusable
    /// document both resolve to [`Capabilities::unmanaged`].
    pub fn resolve(doc: Option<&InstallProvisioning>) -> Self {
        match doc {
            Some(doc) if doc.is_usable() => Self::from_provisioning(doc),
            _ => Self::unmanaged(),
        }
    }
}

// ---------------------------------------------------------------------------
// First-run settings seed
// ---------------------------------------------------------------------------

/// Apply an installer's answers to a **brand-new** `GeneralSettings`.
///
/// Called only when there is no `settings.json` yet — the installer's
/// answers are a starting point, not a policy. Overwriting an existing file
/// would mean a Repair silently reverting settings the user had since
/// changed, which is the opposite of respecting their choices.
///
/// `capabilities` participates because the wizard can produce a
/// contradiction: "Start Clippity at login" is an Options-step toggle while
/// the startup helper is a Components-step item, and nothing stops a user
/// from ticking the first and declining the second. A setting the app has
/// decided not to offer must not be seeded on, or the UI would hide a row
/// that is quietly enabled.
pub fn seed_general_settings(
    doc: &InstallProvisioning,
    capabilities: &Capabilities,
    general: &mut crate::settings::GeneralSettings,
) {
    let prefs = doc.preferences;
    general.start_on_startup = prefs.start_at_login && capabilities.start_at_login;
    general.automatic_updates = prefs.automatic_updates;
    general.help_improve = prefs.help_improve;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A document listing exactly `components`, with default preferences.
    fn doc_with(components: &[&str]) -> InstallProvisioning {
        InstallProvisioning {
            schema_version: SUPPORTED_SCHEMA_VERSION,
            product_id: PRODUCT_ID.into(),
            version: "1.5.0".into(),
            written_at: "2026-07-25T10:00:00Z".into(),
            scope: InstallScope::CurrentUser,
            components: components.iter().map(|s| s.to_string()).collect(),
            preferences: ProvisionedPreferences::default(),
        }
    }

    /// The full recommended selection — nothing declined.
    fn everything() -> InstallProvisioning {
        doc_with(&["core", "capture", "assoc", "startup", "gif", "ocr", "cloud"])
    }

    // ---------- the absent / untrusted cases ----------

    #[test]
    fn no_document_enables_everything_and_says_it_is_unmanaged() {
        // Portable builds and `cargo run` have no installer behind them.
        let caps = Capabilities::resolve(None);
        assert!(caps.unmanaged);
        assert!(caps.global_hotkeys);
        assert!(caps.text_recognition);
        assert!(caps.gif_recording);
        assert!(caps.cloud_sync);
    }

    #[test]
    fn a_newer_schema_is_ignored_rather_than_partially_applied() {
        // Fields we cannot interpret must not disable the features they
        // describe — the user would see features vanish after an update.
        let mut doc = doc_with(&["core"]);
        doc.schema_version = SUPPORTED_SCHEMA_VERSION + 1;
        assert!(!doc.is_usable());
        let caps = Capabilities::resolve(Some(&doc));
        assert!(caps.unmanaged);
        assert!(caps.text_recognition, "declined-looking doc must not gate");
    }

    #[test]
    fn a_document_for_another_product_is_ignored() {
        let mut doc = doc_with(&["core"]);
        doc.product_id = "com.example.other".into();
        assert!(!doc.is_usable());
        assert!(Capabilities::resolve(Some(&doc)).unmanaged);
    }

    #[test]
    fn a_document_without_a_product_id_is_still_ours() {
        // The field is optional, and the file's location beside our own exe
        // is already strong evidence — rejecting it would break forward
        // compatibility for no gain.
        let mut doc = everything();
        doc.product_id = String::new();
        assert!(doc.is_usable());
        assert!(!Capabilities::resolve(Some(&doc)).unmanaged);
    }

    // ---------- component gating ----------

    #[test]
    fn a_full_install_enables_every_feature() {
        let caps = Capabilities::resolve(Some(&everything()));
        assert!(!caps.unmanaged);
        assert!(caps.global_hotkeys);
        assert!(caps.text_recognition);
        assert!(caps.gif_recording);
        assert!(caps.start_at_login);
        assert!(caps.file_associations);
        assert!(caps.cloud_sync);
    }

    #[test]
    fn a_declined_component_gates_exactly_its_own_feature() {
        // The recommended default selection: no GIF, no OCR, no cloud.
        let caps = Capabilities::resolve(Some(&doc_with(&[
            "core", "capture", "assoc", "startup",
        ])));
        assert!(!caps.text_recognition, "OCR was declined");
        assert!(!caps.gif_recording, "GIF encoder was declined");
        assert!(!caps.cloud_sync, "cloud sync was declined");
        // …and nothing else moved.
        assert!(caps.global_hotkeys);
        assert!(caps.start_at_login);
        assert!(caps.file_associations);
    }

    #[test]
    fn a_core_only_install_gates_every_optional_feature() {
        let caps = Capabilities::resolve(Some(&doc_with(&["core"])));
        assert!(!caps.global_hotkeys);
        assert!(!caps.text_recognition);
        assert!(!caps.gif_recording);
        assert!(!caps.start_at_login);
        assert!(!caps.file_associations);
        assert!(!caps.cloud_sync);
        // Still a managed install — the app knows these were real answers.
        assert!(!caps.unmanaged);
    }

    #[test]
    fn an_empty_component_list_is_missing_information_not_a_bare_install() {
        // Only a broken manifest can record zero components (`core` is not
        // declinable), and "hide every feature" is the wrong reading of it.
        let mut doc = everything();
        doc.components.clear();
        let caps = Capabilities::resolve(Some(&doc));
        assert!(caps.global_hotkeys);
        assert!(caps.text_recognition);
        assert!(caps.gif_recording);
        // Preferences are recorded independently, so they are still honored.
        assert!(!caps.unmanaged);
    }

    #[test]
    fn unknown_component_ids_are_carried_without_effect() {
        let mut doc = everything();
        doc.components.push("some-future-feature".into());
        assert_eq!(Capabilities::resolve(Some(&doc)), Capabilities::resolve(Some(&everything())));
    }

    // ---------- preference gating ----------

    #[test]
    fn preferences_gate_updates_reporting_and_associations() {
        let mut doc = everything();
        doc.preferences.automatic_updates = false;
        doc.preferences.help_improve = false;
        doc.preferences.file_associations = false;
        let caps = Capabilities::resolve(Some(&doc));
        assert!(!caps.automatic_updates);
        assert!(!caps.usage_reporting);
        assert!(!caps.file_associations, "handler installed but not wanted");
    }

    // ---------- deserialization ----------

    #[test]
    fn the_installers_document_deserializes() {
        // Byte-for-byte the shape `installer_domain::provisioning` writes.
        let json = r#"{
            "schemaVersion": 1,
            "productId": "com.clippity.app",
            "version": "1.5.0",
            "writtenAt": "2026-07-25T10:00:00Z",
            "scope": "current-user",
            "components": ["core", "capture", "assoc", "startup"],
            "preferences": {
                "desktopShortcut": true,
                "startAtLogin": true,
                "automaticUpdates": false,
                "helpImprove": false,
                "fileAssociations": true
            }
        }"#;
        let doc: InstallProvisioning = serde_json::from_str(json).expect("parses");
        assert!(doc.is_usable());
        assert!(doc.has_component("capture"));
        assert!(!doc.has_component("ocr"));
        assert!(doc.preferences.start_at_login);
        assert!(!doc.preferences.automatic_updates);
    }

    #[test]
    fn a_document_missing_optional_fields_reads_as_installer_defaults() {
        // A future installer that drops fields must not read as "the user
        // declined them" — every omitted flag ships on except start-at-login.
        let json = r#"{ "schemaVersion": 1, "components": ["core", "ocr"] }"#;
        let doc: InstallProvisioning = serde_json::from_str(json).expect("parses");
        assert!(doc.preferences.automatic_updates);
        assert!(doc.preferences.help_improve);
        assert!(doc.preferences.file_associations);
        assert!(!doc.preferences.start_at_login, "start-at-login ships off");
        assert_eq!(doc.scope, InstallScope::CurrentUser);
    }

    #[test]
    fn a_document_without_a_schema_version_is_rejected() {
        // The one required field: without it we cannot know whether the rest
        // means what we think it means.
        let json = r#"{ "components": ["core"] }"#;
        assert!(serde_json::from_str::<InstallProvisioning>(json).is_err());
    }

    // ---------- first-run seed ----------

    #[test]
    fn the_seed_carries_the_wizards_answers_into_settings() {
        let mut doc = everything();
        doc.preferences.start_at_login = true;
        doc.preferences.automatic_updates = false;
        doc.preferences.help_improve = false;
        let caps = Capabilities::resolve(Some(&doc));

        let mut general = crate::settings::GeneralSettings::default();
        seed_general_settings(&doc, &caps, &mut general);
        assert!(general.start_on_startup);
        assert!(!general.automatic_updates);
        assert!(!general.help_improve);
    }

    #[test]
    fn the_seed_never_enables_a_setting_the_app_will_not_offer() {
        // "Start at login" ticked, startup helper declined — a contradiction
        // the wizard permits. Seeding it on would leave the app starting with
        // Windows while the Settings row that controls it is hidden.
        let mut doc = doc_with(&["core", "capture"]);
        doc.preferences.start_at_login = true;
        let caps = Capabilities::resolve(Some(&doc));
        assert!(!caps.start_at_login);

        let mut general = crate::settings::GeneralSettings::default();
        seed_general_settings(&doc, &caps, &mut general);
        assert!(!general.start_on_startup);
    }

    #[test]
    fn the_seed_leaves_unrelated_general_settings_alone() {
        let doc = everything();
        let caps = Capabilities::resolve(Some(&doc));
        let mut general = crate::settings::GeneralSettings {
            captures_dir: r"D:\Shots".into(),
            name_template: "{label}-{date}".into(),
            onboarded: true,
            ..Default::default()
        };
        seed_general_settings(&doc, &caps, &mut general);
        assert_eq!(general.captures_dir, r"D:\Shots");
        assert_eq!(general.name_template, "{label}-{date}");
        assert!(general.onboarded);
    }

    #[test]
    fn capabilities_serialize_camel_case_for_the_frontend() {
        let json = serde_json::to_string(&Capabilities::unmanaged()).unwrap();
        for key in [
            "\"globalHotkeys\"",
            "\"textRecognition\"",
            "\"gifRecording\"",
            "\"startAtLogin\"",
            "\"fileAssociations\"",
            "\"cloudSync\"",
            "\"automaticUpdates\"",
            "\"usageReporting\"",
            "\"unmanaged\"",
        ] {
            assert!(json.contains(key), "missing {key} in {json}");
        }
    }
}
