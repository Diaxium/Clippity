//! Settings domain — pure types + validation. **No I/O.**
//!
//! The persisted shape on disk (and the wire shape across IPC) is
//! `Settings { general, appearance, notifications }`. Each sub-struct
//! holds `#[serde(default)]` on every field so an older settings.json
//! cleanly upgrades — missing fields fall back to defaults rather than
//! erroring.
//!
//! Reserved sub-structs (Capture/Editor/Shortcuts/Vision/Models) are
//! intentionally **not** present in this MVP. The serde default cascade
//! at `Settings`-level means a future port adding them is forward-
//! compatible: an older on-disk settings.json silently gains the new
//! section when the next save runs.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::scroll::ScrollDirection;
use crate::toast::{ToastCorner, ToastDurations};

/// Theme preference. `System` is resolved against the OS color-scheme
/// query in the frontend's `Providers.tsx` so the resolved
/// `themeStore.theme` stays `"light" | "dark"` (the form Tailwind
/// `[data-theme]` + Mica backdrop sync care about).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ThemePref {
    Light,
    Dark,
    #[default]
    System,
}

/// Default accent — Clippity brand coral. Matches the legacy
/// `AppearanceSettings::default_accent` so an unchanged settings.json
/// renders the same as v0.
fn default_accent() -> String {
    "#FF6E4A".into()
}

/// Corner-roundness preference. Scales the whole `--radius-*` token
/// family in the frontend (`theme.css` → `--radius-scale`), so cards,
/// panels, buttons, and inputs feel sharper or softer app-wide without
/// per-component edits. `Default` reproduces the shipped radii.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum RadiusScale {
    /// Tight corners — near-square, technical feel.
    Sharp,
    /// The shipped radius scale.
    #[default]
    Default,
    /// Softer, more pill-like corners.
    Round,
}

/// UI density preference. Drives Tailwind's `--spacing` base in the
/// full-window chrome (dashboard / capture home), so `Compact` tightens
/// every spacing-derived padding, gap, and inset at once. Deliberately
/// **not** applied to the coordinate-sensitive overlay or the
/// backend-sized utility windows (countdown / toast / tray).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Density {
    /// The shipped spacing — roomy, breathable.
    #[default]
    Comfortable,
    /// Tighter spacing so more fits on screen (library, settings).
    Compact,
}

/// Application-icon style. Selects which bundled mark drives the system
/// tray icon, the per-window taskbar icons, and the in-app `Brand`
/// component. The theme (light/dark) still picks the matching asset
/// within the chosen style. Changing the built *executable* icon isn't
/// possible at runtime — this covers every icon the running process
/// controls.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AppIconStyle {
    /// Full-colour Clippity mark.
    #[default]
    Color,
    /// Single-hue monochrome glyph — blends into a busy tray / taskbar.
    Monochrome,
}

/// Native transparent-window material. The performance `window_effects`
/// switch remains the master on/off gate; this chooses which backdrop is
/// used when effects are enabled.
///
/// The materials differ in *what* they show, not just how strongly:
/// Mica and Tabbed are wallpaper-derived — DWM samples the desktop
/// wallpaper once and blurs it, so nothing behind the window (other
/// apps, video, a moving window) ever shows through no matter how
/// transparent the app chrome is made. Acrylic and Blur sample live
/// content. `Clear` removes the material entirely so the transparent
/// window is a plain hole onto whatever is behind it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum WindowBackdrop {
    /// Windows 11's default Mica material.
    #[default]
    Mica,
    /// Stronger transient-window acrylic blur.
    Acrylic,
    /// Legacy blur-behind material.
    Blur,
    /// Windows 11 tabbed Mica variant.
    Tabbed,
    /// No native material at all — the transparent window shows the
    /// desktop / other apps behind it directly, unblurred. The only
    /// mode where lowering chrome opacity reveals *live* content on
    /// every Windows build.
    Clear,
}

impl WindowBackdrop {
    /// Whether the material takes a tint colour. Mica / Tabbed are
    /// wallpaper-derived system backdrops that DWM tints itself, and
    /// `Clear` paints nothing — for those the `tint_strength` knob is a
    /// no-op and the UI hides it.
    pub fn accepts_tint(self) -> bool {
        matches!(self, Self::Acrylic | Self::Blur)
    }

    /// Whether the material samples live content behind the window
    /// (rather than the wallpaper). Drives the "this is why lowering
    /// transparency doesn't reveal your desktop" hint in the UI.
    pub fn samples_live_content(self) -> bool {
        matches!(self, Self::Acrylic | Self::Blur | Self::Clear)
    }
}

/// Per-material tuning envelopes (percent). Every knob is stored
/// loosely and clamped on the way in, mirroring `window_opacity`.
pub const MIN_BACKDROP_TINT_PCT: u8 = 0;
pub const MAX_BACKDROP_TINT_PCT: u8 = 100;
pub const MIN_BACKDROP_GLASS_PCT: u8 = 0;
pub const MAX_BACKDROP_GLASS_PCT: u8 = 150;
pub const MIN_BACKDROP_BLUR_PCT: u8 = 0;
pub const MAX_BACKDROP_BLUR_PCT: u8 = 200;
pub const MIN_BACKDROP_SATURATION_PCT: u8 = 50;
pub const MAX_BACKDROP_SATURATION_PCT: u8 = 200;

/// Neutral value for the three "scale the shipped look" knobs — 100 %
/// reproduces exactly what the app rendered before tuning existed.
const NEUTRAL_PCT: u8 = 100;
/// Shipped tint for the two tintable materials — 70 % ≈ the alpha 178
/// the acrylic tint was hardcoded to before this was user-facing.
const DEFAULT_TINT_PCT: u8 = 70;

fn default_neutral_pct() -> u8 {
    NEUTRAL_PCT
}

fn default_tint_pct() -> u8 {
    DEFAULT_TINT_PCT
}

/// Fine-tuning for one backdrop material.
///
/// The backdrop picker is coarse — it chooses *which* DWM material to
/// ask for — and the materials behave differently enough that one set
/// of numbers can't flatter all of them. These four knobs are stored
/// per material so switching between them restores that material's own
/// tuning rather than dragging one compromise across all of them.
///
/// - `tint_strength` — alpha of the colour blended into the *native*
///   material. Only Acrylic and Blur take one (see
///   [`WindowBackdrop::accepts_tint`]); on Windows 11 22H2+ acrylic is
///   a DWM system backdrop that tints itself, so it lands only on
///   Windows 10 / older builds where the legacy composition attribute
///   is used.
/// - `glass_strength` — multiplier on the stacked in-app glass layers.
///   This is the knob that decides how much of the native material is
///   actually visible through the app's own panels; at 0 the panels
///   stop painting entirely.
/// - `blur_strength` — multiplier on the CSS `backdrop-filter` blur
///   radii. Lower = the material reads sharper through the chrome.
/// - `saturation` — CSS `backdrop-filter: saturate()`. Pushes colour
///   back into materials (Mica especially) that wash out when the
///   chrome above them goes transparent.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackdropTuning {
    #[serde(default = "default_tint_pct")]
    pub tint_strength: u8,
    #[serde(default = "default_neutral_pct")]
    pub glass_strength: u8,
    #[serde(default = "default_neutral_pct")]
    pub blur_strength: u8,
    #[serde(default = "default_neutral_pct")]
    pub saturation: u8,
}

impl BackdropTuning {
    pub const fn new(
        tint_strength: u8,
        glass_strength: u8,
        blur_strength: u8,
        saturation: u8,
    ) -> Self {
        Self {
            tint_strength,
            glass_strength,
            blur_strength,
            saturation,
        }
    }

    /// Pure: clamp every knob into its envelope.
    pub fn clamped(self) -> Self {
        Self {
            tint_strength: self
                .tint_strength
                .clamp(MIN_BACKDROP_TINT_PCT, MAX_BACKDROP_TINT_PCT),
            glass_strength: self
                .glass_strength
                .clamp(MIN_BACKDROP_GLASS_PCT, MAX_BACKDROP_GLASS_PCT),
            blur_strength: self
                .blur_strength
                .clamp(MIN_BACKDROP_BLUR_PCT, MAX_BACKDROP_BLUR_PCT),
            saturation: self
                .saturation
                .clamp(MIN_BACKDROP_SATURATION_PCT, MAX_BACKDROP_SATURATION_PCT),
        }
    }

    /// 0–255 alpha for the native material tint, from the clamped
    /// percent. The platform layer feeds this straight into
    /// `window_vibrancy`'s tint colour.
    pub fn tint_alpha(self) -> u8 {
        ((self.clamped().tint_strength as u16 * 255) / 100) as u8
    }
}

impl Default for BackdropTuning {
    fn default() -> Self {
        Self::new(DEFAULT_TINT_PCT, NEUTRAL_PCT, NEUTRAL_PCT, NEUTRAL_PCT)
    }
}

/// Shipped tuning for every material that doesn't read a tint. Blur's
/// tint used to be hardcoded to alpha 1 (visually none), `Clear` paints
/// no material at all, and Mica / Tabbed are DWM system backdrops that
/// tint themselves — storing 70 for those would look meaningful and
/// never do anything.
fn default_untinted_tuning() -> BackdropTuning {
    BackdropTuning::new(0, NEUTRAL_PCT, NEUTRAL_PCT, NEUTRAL_PCT)
}

/// One [`BackdropTuning`] per material. A named struct rather than a map
/// so a settings file written before a material existed still parses
/// into that material's shipped default (`#[serde(default)]` per field)
/// and every lookup is total.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackdropTuningSet {
    #[serde(default = "default_untinted_tuning")]
    pub mica: BackdropTuning,
    #[serde(default)]
    pub acrylic: BackdropTuning,
    #[serde(default = "default_untinted_tuning")]
    pub blur: BackdropTuning,
    #[serde(default = "default_untinted_tuning")]
    pub tabbed: BackdropTuning,
    #[serde(default = "default_untinted_tuning")]
    pub clear: BackdropTuning,
}

impl BackdropTuningSet {
    /// The tuning for one material. Total — every variant has an entry.
    pub fn get(&self, backdrop: WindowBackdrop) -> BackdropTuning {
        match backdrop {
            WindowBackdrop::Mica => self.mica,
            WindowBackdrop::Acrylic => self.acrylic,
            WindowBackdrop::Blur => self.blur,
            WindowBackdrop::Tabbed => self.tabbed,
            WindowBackdrop::Clear => self.clear,
        }
    }

    /// Replace the tuning for one material, leaving the others alone.
    pub fn set(&mut self, backdrop: WindowBackdrop, tuning: BackdropTuning) {
        let slot = match backdrop {
            WindowBackdrop::Mica => &mut self.mica,
            WindowBackdrop::Acrylic => &mut self.acrylic,
            WindowBackdrop::Blur => &mut self.blur,
            WindowBackdrop::Tabbed => &mut self.tabbed,
            WindowBackdrop::Clear => &mut self.clear,
        };
        *slot = tuning;
    }

    /// Pure: clamp every material's knobs into their envelopes.
    pub fn clamped(self) -> Self {
        Self {
            mica: self.mica.clamped(),
            acrylic: self.acrylic.clamped(),
            blur: self.blur.clamped(),
            tabbed: self.tabbed.clamped(),
            clear: self.clear.clamped(),
        }
    }
}

impl Default for BackdropTuningSet {
    fn default() -> Self {
        Self {
            mica: default_untinted_tuning(),
            // The one material whose tint the platform layer actually
            // forwards on a build where it still lands.
            acrylic: BackdropTuning::default(),
            blur: default_untinted_tuning(),
            tabbed: default_untinted_tuning(),
            clear: default_untinted_tuning(),
        }
    }
}

/// Chrome opacity envelope (percent). 10 % is intentionally very
/// transparent for users who want the native backdrop / desktop to show
/// strongly; 100 % is fully opaque (the default).
pub const MIN_WINDOW_OPACITY_PCT: u8 = 10;
pub const MAX_WINDOW_OPACITY_PCT: u8 = 100;

/// UI-scale envelope (percent). Applied as a CSS `zoom` on the
/// full-window chrome, so it magnifies px-based type and layout alike.
/// 80–120 % keeps the layout coherent (below 80 % text gets cramped,
/// above 120 % panels start to clip).
pub const MIN_UI_SCALE_PCT: u8 = 80;
pub const MAX_UI_SCALE_PCT: u8 = 120;

fn default_window_opacity() -> u8 {
    MAX_WINDOW_OPACITY_PCT
}

fn default_ui_scale() -> u8 {
    100
}

/// Pure: clamp a stored chrome-opacity percent into the valid envelope.
pub fn clamp_window_opacity(pct: u8) -> u8 {
    pct.clamp(MIN_WINDOW_OPACITY_PCT, MAX_WINDOW_OPACITY_PCT)
}

/// Pure: clamp a stored UI-scale percent into the valid envelope.
pub fn clamp_ui_scale(pct: u8) -> u8 {
    pct.clamp(MIN_UI_SCALE_PCT, MAX_UI_SCALE_PCT)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    /// User-chosen captures dir. Empty string = use the fallback
    /// (`AppPaths.captures` = `<app_data>/captures`).
    #[serde(default)]
    pub captures_dir: String,
    /// Capture file-name template (Settings → General). Empty string =
    /// use the built-in default (`domain::naming::DEFAULT_TEMPLATE`).
    /// Tokens: `{label}` (mode + window when known), `{window}`,
    /// `{type}`, `{date}`, `{time}`. The capture pipelines read this
    /// through `NameTemplateSource` so a change takes effect on the very
    /// next capture, no restart.
    #[serde(default)]
    pub name_template: String,
    /// Persisted intent. Wiring into `tauri-plugin-autostart` lands
    /// with production-polish phase — tracked in REBUILD.md tech debt.
    ///
    /// Seeded on first launch from the installer's "Start Clippity at
    /// login" answer (`provisioning::ProvisionedPreferences::start_at_login`),
    /// so the box the user ticked in the wizard is the state they find in
    /// Settings. Editable afterwards like any other setting — the
    /// installer's answer is a starting point, not a lock.
    #[serde(default)]
    pub start_on_startup: bool,
    /// Whether Clippity may check for and apply updates on its own.
    ///
    /// Seeded on first launch from the installer's "Enable automatic
    /// updates" answer. **Persisted intent only in this build** — there is
    /// no updater yet, so nothing reads this to go to the network. It is
    /// stored (and surfaced in Settings) so the wizard's answer is not
    /// silently discarded, and so the updater port has the user's
    /// preference waiting for it rather than having to ask again.
    #[serde(default = "default_true")]
    pub automatic_updates: bool,
    /// Whether Clippity may share anonymous usage and diagnostic data.
    ///
    /// Seeded on first launch from the installer's "Help improve Clippity"
    /// answer. **Persisted intent only in this build** — Clippity sends no
    /// telemetry, so this gates nothing today. It ships from whatever the
    /// user chose in the wizard rather than from an assumption, which is
    /// the point: the first code that wants to report anything has to find
    /// a real answer here, not a default it invented.
    #[serde(default = "default_true")]
    pub help_improve: bool,
    /// True once the user has completed the first-launch onboarding
    /// wizard. The frontend gates the wizard on `!onboarded`, then
    /// `settings_update({ general: { ..., onboarded: true } })` flips
    /// it. Default `false` so older settings.json files (and brand-new
    /// installs) trigger the wizard on next launch.
    #[serde(default)]
    pub onboarded: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            captures_dir: String::new(),
            name_template: String::new(),
            start_on_startup: false,
            automatic_updates: true,
            help_improve: true,
            onboarded: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    #[serde(default)]
    pub theme: ThemePref,
    #[serde(default = "default_accent")]
    pub accent: String,
    /// Chrome opacity, percent. Drives transparency paint tokens in
    /// `theme.css`, letting the native backdrop / desktop bleed through
    /// the window shell. Stored loosely; readers clamp into
    /// `MIN_WINDOW_OPACITY_PCT..=MAX_WINDOW_OPACITY_PCT`.
    #[serde(default = "default_window_opacity")]
    pub window_opacity: u8,
    /// Native backdrop material used behind the translucent app chrome
    /// when `performance.window_effects` is enabled.
    #[serde(default)]
    pub window_backdrop: WindowBackdrop,
    /// Per-material fine-tuning for `window_backdrop`. Kept per material
    /// so switching backdrops restores that material's own numbers.
    /// Stored loosely; readers clamp via `BackdropTuningSet::clamped`.
    #[serde(default)]
    pub backdrop_tuning: BackdropTuningSet,
    /// UI zoom, percent. Applied as a CSS `zoom` on the full-window
    /// chrome so px type + layout scale together. Stored loosely;
    /// readers clamp into `MIN_UI_SCALE_PCT..=MAX_UI_SCALE_PCT`.
    #[serde(default = "default_ui_scale")]
    pub ui_scale: u8,
    /// Corner-roundness scale for the `--radius-*` token family.
    #[serde(default)]
    pub corner_radius: RadiusScale,
    /// Spacing density for the full-window chrome.
    #[serde(default)]
    pub density: Density,
    /// Which bundled mark drives the tray / taskbar / in-app icon.
    #[serde(default)]
    pub app_icon: AppIconStyle,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: ThemePref::default(),
            accent: default_accent(),
            window_opacity: default_window_opacity(),
            window_backdrop: WindowBackdrop::default(),
            backdrop_tuning: BackdropTuningSet::default(),
            ui_scale: default_ui_scale(),
            corner_radius: RadiusScale::default(),
            density: Density::default(),
            app_icon: AppIconStyle::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    #[serde(default)]
    pub corner: ToastCorner,
    #[serde(default)]
    pub durations: ToastDurations,
}

/// PNG encoding effort for the capture-save pipeline. The capture
/// service maps each variant to a concrete `image`-crate
/// `CompressionType` + `FilterType` pair — the domain stays I/O-free
/// and only names the user-facing intent.
///
/// `Balanced` reproduces the historic default (`DynamicImage::write_to`
/// uses `CompressionType::Default` + adaptive filtering), so an
/// unchanged settings.json encodes captures exactly as it did before
/// this knob existed.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureCompression {
    /// Fastest encode, largest files — least CPU per capture.
    Fast,
    /// The historic default: balanced speed vs size.
    #[default]
    Balanced,
    /// Smallest files, slowest encode — most CPU per capture.
    Small,
}

/// Default for the two opt-out performance booleans. Serde's bare
/// `#[serde(default)]` would use `bool::default()` (= false), the wrong
/// default for a toggle that ships enabled, so those fields point here
/// and the struct carries a hand-written `Default`.
fn default_true() -> bool {
    true
}

/// Performance / rendering knobs. Every field is independently
/// `#[serde(default)]` so an older settings.json that predates this
/// whole section upgrades cleanly, and within the section a file from a
/// build that knew only some fields still parses.
///
/// - `gpu_acceleration`: drives the WebView2 `--disable-gpu` browser
///   arg, read once at process start (`run()` in lib.rs). Changing it
///   needs an app restart — the arg is fixed when the webview's
///   environment is created.
/// - `window_effects`: when false the Win11 Mica backdrop is cleared
///   and the frontend drops `backdrop-filter` blur — lighter on the DWM
///   compositor + GPU. Applies live.
/// - `reduced_animations`: the single motion master — the frontend maps
///   it onto `data-motion` (ORed with the OS `prefers-reduced-motion`).
/// - `capture_compression`: PNG encode effort for the capture pipeline.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSettings {
    #[serde(default = "default_true")]
    pub gpu_acceleration: bool,
    #[serde(default = "default_true")]
    pub window_effects: bool,
    #[serde(default)]
    pub reduced_animations: bool,
    #[serde(default)]
    pub capture_compression: CaptureCompression,
}

impl Default for PerformanceSettings {
    fn default() -> Self {
        Self {
            gpu_acceleration: true,
            window_effects: true,
            reduced_animations: false,
            capture_compression: CaptureCompression::default(),
        }
    }
}

/// Default palette swatch count — mirrors
/// `domain::palette::DEFAULT_PALETTE_COUNT`. A free function so it can
/// back both `#[serde(default = …)]` and the `Default` impl.
fn default_palette_count() -> u8 {
    crate::palette::DEFAULT_PALETTE_COUNT as u8
}

/// Capture-delay envelope (seconds). Mirrors the frontend capture
/// store's `MIN_DELAY`/`MAX_DELAY` — 1 s is the shortest useful wait,
/// 60 s the longest the stepper exposes.
pub const DEFAULT_DELAY_SECONDS: u8 = 5;
pub const MIN_DELAY_SECONDS: u8 = 1;
pub const MAX_DELAY_SECONDS: u8 = 60;

fn default_delay_seconds() -> u8 {
    DEFAULT_DELAY_SECONDS
}

/// The `preview` capture default ships **on** — opening a fresh capture
/// in the editor is the expected baseline. A free function so it backs
/// both `#[serde(default = …)]` and the `Default` impl.
fn default_preview() -> bool {
    true
}

/// Pure: clamp a stored capture-delay seconds value into the valid
/// envelope. Mirrors `clamp_confidence` / `clamp_window_opacity`.
pub fn clamp_delay_seconds(secs: u8) -> u8 {
    secs.clamp(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS)
}

/// Capture-behaviour knobs — the defaults a fresh capture window opens
/// with, plus the palette swatch count. This section is the persisted
/// home for every "capture option" the capture window exposes: the
/// frontend seeds its per-session capture store from these on launch,
/// so a user's preferred toggles/delay survive restarts instead of
/// resetting to hardcoded values every time.
///
/// Every field is independently `#[serde(default)]` so an older
/// settings.json that predates the section (or a build that knew only
/// `palette_count`) upgrades cleanly — missing fields fall back to the
/// shipped defaults rather than erroring.
///
/// - `preview` / `clipboard` / `cursor` / `enhance`: the four capture
///   option toggles. `preview` ships on (open the shot in the editor);
///   the rest ship off — a screenshot tool's baseline promise is "what
///   you saw", so cursor/enhance are opt-in, and clipboard-copy is a
///   deliberate choice.
/// - `delay` / `delay_seconds`: the pre-capture countdown default and
///   its length. Stored loosely; readers clamp `delay_seconds` into
///   `MIN_DELAY_SECONDS..=MAX_DELAY_SECONDS`.
/// - `scroll_direction`: the default axis for Scrolling-Window /
///   Panoramic captures.
/// - `palette_count`: default swatches a Palette capture extracts.
///   Stored loosely; the read accessor clamps it into
///   `domain::palette::{MIN,MAX}_PALETTE_COUNT`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSettings {
    /// Default "Preview in Editor" toggle — open the new capture in the
    /// editor after taking it. Ships on.
    #[serde(default = "default_preview")]
    pub preview: bool,
    /// Default "Copy to Clipboard" toggle. Ships off.
    #[serde(default)]
    pub clipboard: bool,
    /// Default "Capture Cursor" toggle. Ships off.
    #[serde(default)]
    pub cursor: bool,
    /// Default "Smart Enhance" toggle (auto-levels + light unsharp).
    /// Ships off — enhancement is a judgement call about the pixels.
    #[serde(default)]
    pub enhance: bool,
    /// Default "Capture Delay" toggle — arm the pre-capture countdown.
    /// Ships off.
    #[serde(default)]
    pub delay: bool,
    /// Default countdown length, in seconds. Stored loosely; the read
    /// accessor clamps it into `MIN_DELAY_SECONDS..=MAX_DELAY_SECONDS`.
    #[serde(default = "default_delay_seconds")]
    pub delay_seconds: u8,
    /// Default stitch/auto-scroll axis for Scrolling-Window + Panoramic
    /// captures. `Down` (read a long page top-to-bottom).
    #[serde(default)]
    pub scroll_direction: ScrollDirection,
    /// Default number of swatches a Palette capture extracts. Stored
    /// loosely; the read accessor clamps it into
    /// `domain::palette::{MIN,MAX}_PALETTE_COUNT`.
    #[serde(default = "default_palette_count")]
    pub palette_count: u8,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            preview: default_preview(),
            clipboard: false,
            cursor: false,
            enhance: false,
            delay: false,
            delay_seconds: default_delay_seconds(),
            scroll_direction: ScrollDirection::default(),
            palette_count: default_palette_count(),
        }
    }
}

/// Default object-detection model id — delegates to the registry so
/// the two can't drift.
fn default_object_model() -> String {
    crate::models::DEFAULT_OBJECT_MODEL.to_string()
}

/// Default detector confidence threshold, in percent.
fn default_confidence() -> u8 {
    DEFAULT_CONFIDENCE_PCT
}

/// AI-model preferences — the Models settings page. The model files
/// themselves are managed by `services::model_service`; this section
/// only stores user intent.
///
/// - `auto_download`: when the user arms an AI feature whose model
///   isn't installed yet, fetch it automatically instead of bouncing
///   them to Settings → Models. Ships on — the whole point of managed
///   models is that they "just work" — and is the user's kill switch
///   for surprise network traffic.
/// - `object_model`: registry id of the detector backing the Object
///   capture mode. Stored loosely; readers fall back to the registry
///   default when the id is stale/unknown.
/// - `confidence`: detector confidence threshold in percent. Stored
///   loosely; the read accessor clamps into
///   `MIN_CONFIDENCE_PCT..=MAX_CONFIDENCE_PCT`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelsSettings {
    #[serde(default = "default_true")]
    pub auto_download: bool,
    #[serde(default = "default_object_model")]
    pub object_model: String,
    #[serde(default = "default_confidence")]
    pub confidence: u8,
}

impl Default for ModelsSettings {
    fn default() -> Self {
        Self {
            auto_download: true,
            object_model: default_object_model(),
            confidence: default_confidence(),
        }
    }
}

/// Confidence-threshold envelope (percent). 25 % is a sane default for
/// both detector families; below 5 % is noise, above 95 % returns
/// nearly nothing.
pub const DEFAULT_CONFIDENCE_PCT: u8 = 25;
pub const MIN_CONFIDENCE_PCT: u8 = 5;
pub const MAX_CONFIDENCE_PCT: u8 = 95;

/// Pure: clamp a stored confidence percent into the valid envelope.
pub fn clamp_confidence(pct: u8) -> u8 {
    pct.clamp(MIN_CONFIDENCE_PCT, MAX_CONFIDENCE_PCT)
}

/// Default OS-global capture hotkey. Ships enabled so a fresh install
/// has a system-wide "grab a region" key without a settings trip. `Mod`
/// is Ctrl on Windows/Linux, ⌘ on macOS (see the frontend keybind
/// primitives); `Ctrl+Shift+2` is unlikely to collide with a foreground
/// app's own accelerators. Empty string = no global hotkey.
fn default_global_capture() -> String {
    "Mod+Shift+2".into()
}

/// Keyboard-shortcut customization — the long-reserved `shortcuts`
/// settings section. Two independent concerns:
///
/// - `overrides`: per-binding remaps for the in-app keybind registries
///   (editor / library / quick-capture). The key is a fully-qualified
///   binding id — `"<scope>:<id>"`, e.g. `"editor:select-all"`,
///   `"library:trash-selection"`, `"quickCapture:screenshot"` — and the
///   value is the list of combos that *replace* that binding's registry
///   default. A missing id means "use the default"; an explicit empty
///   vec means "deliberately unbound". A `BTreeMap` so the persisted
///   JSON is stable-ordered (clean diffs, deterministic tests).
/// - `global_capture` / `global_capture_enabled`: the OS-global
///   accelerator that opens the region-capture overlay from anywhere.
///   The backend registers it through `tauri-plugin-global-shortcut`;
///   the combo is stored in the same `Mod+Shift+Key` notation the
///   frontend uses and translated to a plugin `Shortcut` at
///   registration time.
///
/// The domain stays I/O-free and only validates shape — the service
/// layer owns registration and the frontend owns applying `overrides`
/// to its registries.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutsSettings {
    #[serde(default)]
    pub overrides: BTreeMap<String, Vec<String>>,
    #[serde(default = "default_global_capture")]
    pub global_capture: String,
    #[serde(default = "default_true")]
    pub global_capture_enabled: bool,
}

impl Default for ShortcutsSettings {
    fn default() -> Self {
        Self {
            overrides: BTreeMap::new(),
            global_capture: default_global_capture(),
            global_capture_enabled: true,
        }
    }
}

/// Severity floor for one half of the app's logging. Mirrors the
/// `tracing` levels, plus an `Off` that silences the target entirely.
///
/// Kept in the domain (rather than reusing `tracing::Level`) because
/// this is a *persisted user choice* that both halves of the app read:
/// the backend maps it onto an `EnvFilter` directive, the frontend onto
/// its console logger's threshold. Neither mapping belongs in a type the
/// settings file is serialized from.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum LogLevel {
    /// Emit nothing at all.
    Off,
    Error,
    Warn,
    /// The shipped backend level — enough to explain a session without
    /// narrating every frame.
    #[default]
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    /// The `tracing`/`EnvFilter` spelling of this level. Also what the
    /// frontend logger keys its threshold off, so the two halves of a
    /// log file agree on what "debug" means.
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Off => "off",
            LogLevel::Error => "error",
            LogLevel::Warn => "warn",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
            LogLevel::Trace => "trace",
        }
    }

    /// Parse a wire/filter spelling back into a level. Unknown input —
    /// a hand-edited settings file, a frontend that sent something odd
    /// — falls back to `Info` rather than erroring: a log level is never
    /// worth failing a command over.
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" | "none" | "silent" => LogLevel::Off,
            "error" => LogLevel::Error,
            "warn" | "warning" => LogLevel::Warn,
            "debug" => LogLevel::Debug,
            "trace" => LogLevel::Trace,
            _ => LogLevel::Info,
        }
    }

    /// Whether a record at `self` passes a threshold of `min`. `Off`
    /// never passes and never admits anything.
    pub fn allows(self, min: LogLevel) -> bool {
        if min == LogLevel::Off || self == LogLevel::Off {
            return false;
        }
        self.rank() >= min.rank()
    }

    /// Ordering rank — higher is more severe. Private because the
    /// numbers themselves mean nothing outside this comparison.
    fn rank(self) -> u8 {
        match self {
            LogLevel::Off => 0,
            LogLevel::Trace => 1,
            LogLevel::Debug => 2,
            LogLevel::Info => 3,
            LogLevel::Warn => 4,
            LogLevel::Error => 5,
        }
    }
}

/// How long an armed developer mode survives.
///
/// Developer mode reveals destructive actions and can turn on logging
/// that records IPC payloads, so leaving it armed forever after one
/// debugging session is the failure mode this guards against.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum DeveloperExpiry {
    /// Stays on until the user turns it off.
    Never,
    /// Off again on the next launch — the shipped default.
    #[default]
    Restart,
    /// Off again 24 hours after it was armed.
    Day,
}

/// Milliseconds in the [`DeveloperExpiry::Day`] window.
pub const DEVELOPER_DAY_MS: u64 = 24 * 60 * 60 * 1_000;

/// Log-file size envelope, in mebibytes. Below 1 MiB a file rotates
/// before a single session's startup banner is complete; above 64 MiB
/// the retained set stops being something a user can attach to a bug
/// report.
pub const MIN_LOG_FILE_MB: u32 = 1;
pub const MAX_LOG_FILE_MB: u32 = 64;
pub const DEFAULT_LOG_FILE_MB: u32 = 8;

/// Retained rotated files (not counting the live one).
pub const MIN_LOG_FILES: u32 = 1;
pub const MAX_LOG_FILES: u32 = 20;
pub const DEFAULT_LOG_FILES: u32 = 5;

/// Slow-command threshold envelope, in milliseconds. 1 ms flags
/// everything (which is what the IPC inspector's "show all" case wants);
/// 5 s is longer than any command the app makes on purpose.
pub const MIN_SLOW_COMMAND_MS: u32 = 1;
pub const MAX_SLOW_COMMAND_MS: u32 = 5_000;
pub const DEFAULT_SLOW_COMMAND_MS: u32 = 100;

fn default_log_file_mb() -> u32 {
    DEFAULT_LOG_FILE_MB
}

fn default_log_files() -> u32 {
    DEFAULT_LOG_FILES
}

fn default_slow_command_ms() -> u32 {
    DEFAULT_SLOW_COMMAND_MS
}

fn default_backend_log() -> LogLevel {
    LogLevel::Info
}

/// The frontend ships quieter than the backend: its `debug`/`info` are
/// developer flow narration, and every line of it crosses IPC to reach
/// the log file. Problems still get through.
fn default_frontend_log() -> LogLevel {
    LogLevel::Warn
}

/// Pure: clamp a stored log-file size into the valid envelope.
pub fn clamp_log_file_mb(mb: u32) -> u32 {
    mb.clamp(MIN_LOG_FILE_MB, MAX_LOG_FILE_MB)
}

/// Pure: clamp a stored retained-file count into the valid envelope.
pub fn clamp_log_files(count: u32) -> u32 {
    count.clamp(MIN_LOG_FILES, MAX_LOG_FILES)
}

/// Pure: clamp a stored slow-command threshold into the valid envelope.
pub fn clamp_slow_command_ms(ms: u32) -> u32 {
    ms.clamp(MIN_SLOW_COMMAND_MS, MAX_SLOW_COMMAND_MS)
}

/// Developer + diagnostics preferences — Settings → Advanced.
///
/// Two kinds of field live here, and the difference matters:
///
/// - **Presentation gates** (`enabled`, `show_actions`, `performance_overlay`,
///   the per-area diagnostics toggles) decide what the UI reveals. They
///   are inert when developer mode is off.
/// - **Machinery** (`backend_log`, `frontend_log`, `log_to_disk`,
///   `log_max_file_mb`, `log_retain_files`) configures logging for
///   **every** launch, developer mode or not. A user who never opens
///   this page still gets a rotating log file, which is the whole reason
///   a diagnostics bundle is worth exporting.
///
/// Every field is independently `#[serde(default)]`, so a settings.json
/// that predates the section — or a build that knew only some of it —
/// upgrades cleanly.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeveloperSettings {
    /// Master switch. Ships **off**: the actions it reveals delete
    /// caches, simulate failures, and can record IPC payloads.
    #[serde(default)]
    pub enabled: bool,
    /// Unix-epoch milliseconds at which developer mode was last armed.
    /// `0` = unknown (an older file, or armed by a build that predates
    /// the stamp), which [`developer_mode_expired`] treats as "expired"
    /// under the Day policy rather than as "forever".
    #[serde(default)]
    pub enabled_at_ms: u64,
    /// How long an armed developer mode survives.
    #[serde(default)]
    pub expiry: DeveloperExpiry,
    /// Surface developer actions (copy debug info, open logs, inspect)
    /// in ordinary context menus, not just on this page.
    #[serde(default)]
    pub show_actions: bool,
    /// Ask before a destructive developer action runs. Ships **on** —
    /// the actions behind it clear caches and rebuild indexes.
    #[serde(default = "default_true")]
    pub confirm_destructive: bool,
    /// Open the developer tools automatically when a window is created.
    #[serde(default)]
    pub devtools_on_startup: bool,
    /// Severity floor for the Rust `tracing` subscriber.
    #[serde(default = "default_backend_log")]
    pub backend_log: LogLevel,
    /// Severity floor for the frontend logger, and for what it forwards
    /// into the backend's log file so both halves share one timeline.
    #[serde(default = "default_frontend_log")]
    pub frontend_log: LogLevel,
    /// Write the log to disk (rotating files under `<data>/logs`).
    /// Ships **on**: a bug report is worth far more with the session
    /// that produced it attached, and the files are capped + local.
    #[serde(default = "default_true")]
    pub log_to_disk: bool,
    /// Size at which the live log file rotates, in MiB. Read-clamped
    /// into `MIN_LOG_FILE_MB..=MAX_LOG_FILE_MB`.
    #[serde(default = "default_log_file_mb")]
    pub log_max_file_mb: u32,
    /// How many rotated files to keep beside the live one. Read-clamped
    /// into `MIN_LOG_FILES..=MAX_LOG_FILES`.
    #[serde(default = "default_log_files")]
    pub log_retain_files: u32,
    /// Show the live performance overlay in the app windows.
    #[serde(default)]
    pub performance_overlay: bool,
    /// Record the duration, payload size and outcome of every IPC call
    /// so the command inspector has something to show. Off by default —
    /// it retains a rolling window of command metadata.
    #[serde(default)]
    pub command_timing: bool,
    /// Flag any command slower than this, in ms. Read-clamped into
    /// `MIN_SLOW_COMMAND_MS..=MAX_SLOW_COMMAND_MS`.
    #[serde(default = "default_slow_command_ms")]
    pub slow_command_ms: u32,
    /// Show capture timing + monitor/DPI/HDR diagnostics.
    #[serde(default)]
    pub capture_diagnostics: bool,
    /// Show recorder statistics (frames, drops, encoder, file growth).
    #[serde(default)]
    pub recording_diagnostics: bool,
    /// Strip user names, absolute paths and capture file names from an
    /// exported diagnostics bundle. Ships **on** — a bundle is made to
    /// be sent to someone else.
    #[serde(default = "default_true")]
    pub redact_diagnostics: bool,
    /// Per-flag overrides for the frontend's experiment registry. A
    /// missing id means "use the build default"; `true`/`false` force
    /// the flag on or off. A `BTreeMap` so the persisted JSON is
    /// stable-ordered, matching `ShortcutsSettings::overrides`.
    #[serde(default)]
    pub feature_flags: BTreeMap<String, bool>,
}

impl Default for DeveloperSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            enabled_at_ms: 0,
            expiry: DeveloperExpiry::default(),
            show_actions: false,
            confirm_destructive: true,
            devtools_on_startup: false,
            backend_log: default_backend_log(),
            frontend_log: default_frontend_log(),
            log_to_disk: true,
            log_max_file_mb: default_log_file_mb(),
            log_retain_files: default_log_files(),
            performance_overlay: false,
            command_timing: false,
            slow_command_ms: default_slow_command_ms(),
            capture_diagnostics: false,
            recording_diagnostics: false,
            redact_diagnostics: true,
            feature_flags: BTreeMap::new(),
        }
    }
}

impl DeveloperSettings {
    /// The log-file cap these settings describe, in **bytes**, clamped.
    pub fn log_max_bytes(&self) -> u64 {
        clamp_log_file_mb(self.log_max_file_mb) as u64 * 1024 * 1024
    }

    /// Retained rotated files, clamped.
    pub fn retained_files(&self) -> u32 {
        clamp_log_files(self.log_retain_files)
    }

    /// The slow-command threshold, clamped.
    pub fn slow_command_ms(&self) -> u32 {
        clamp_slow_command_ms(self.slow_command_ms)
    }
}

/// Pure: has an armed developer mode outlived its expiry policy?
///
/// Evaluated **once at load**, against a fresh process — which is what
/// makes [`DeveloperExpiry::Restart`] mean what it says. `now_ms` is
/// injected rather than read so the rule is testable without a clock.
///
/// A `Day` policy with no arming stamp (`enabled_at_ms == 0`) counts as
/// expired: the safe reading of "we don't know when this was turned on"
/// is not "leave it on indefinitely".
pub fn developer_mode_expired(dev: &DeveloperSettings, now_ms: u64) -> bool {
    if !dev.enabled {
        return false;
    }
    match dev.expiry {
        DeveloperExpiry::Never => false,
        DeveloperExpiry::Restart => true,
        DeveloperExpiry::Day => {
            dev.enabled_at_ms == 0 || now_ms.saturating_sub(dev.enabled_at_ms) >= DEVELOPER_DAY_MS
        }
    }
}

/// `PartialEq` but not `Eq`, since `RecordingSettings` carries a source
/// list positioned with `f32` rectangles (ADR 0033). Nothing needs total
/// equality — the comparisons here are `assert_eq!` and change
/// detection, both of which are satisfied by partial equality.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub general: GeneralSettings,
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub notifications: NotificationSettings,
    #[serde(default)]
    pub performance: PerformanceSettings,
    #[serde(default)]
    pub capture: CaptureSettings,
    #[serde(default)]
    pub recording: RecordingSettings,
    #[serde(default)]
    pub models: ModelsSettings,
    #[serde(default)]
    pub shortcuts: ShortcutsSettings,
    #[serde(default)]
    pub developer: DeveloperSettings,
}

/// Screen-recording defaults (ADR 0031) — what a fresh session starts
/// with.
///
/// A section of its own rather than fields on [`CaptureSettings`]: a
/// recording answers different questions than a still (frame rate,
/// audio inputs) and shares none of that struct's toggles. Same reason
/// `domain::recorder` is separate from `domain::capture`.
///
/// Device ids are stored as `Option<String>`; `None` means "follow the
/// OS default", which is the setting most users want and the one that
/// survives plugging in a headset mid-session. A pinned id that no
/// longer resolves falls back to the default with a warning rather than
/// failing the recording — see `platform::windows::audio`.
/// `PartialEq` but not `Eq`: a source's position is a `NormRect` of
/// `f32`s, and float equality is partial by definition.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSettings {
    /// Mix the microphone into recordings. Ships **off**: a recorder
    /// that silently starts listening to the room the first time it is
    /// used is a privacy surprise, not a convenience.
    #[serde(default)]
    pub microphone: bool,
    /// Mix in what the machine is playing (WASAPI loopback). Also off
    /// by default — a screen recording that unexpectedly captures the
    /// user's music is the other half of the same surprise.
    #[serde(default)]
    pub system_audio: bool,
    /// Pinned microphone endpoint id. `None` = the OS default.
    #[serde(default)]
    pub microphone_device: Option<String>,
    /// Pinned render endpoint id for loopback. `None` = the OS default.
    #[serde(default)]
    pub system_device: Option<String>,
    /// Level each input starts a session at, as a percentage of unity
    /// (`recorder::GAIN_PCT_DEFAULT`). Read-clamped by
    /// [`RecordingSettings::audio`], the same way the frame rates are.
    ///
    /// A *starting* level, not a live one: the HUD's slider moves the
    /// running session and deliberately does not write back here, so a
    /// level nudged for one awkward recording doesn't become the level
    /// every future recording begins at.
    #[serde(default = "default_gain_pct")]
    pub microphone_gain_pct: u16,
    #[serde(default = "default_gain_pct")]
    pub system_gain_pct: u16,
    /// Frame rate for MP4 recordings. Stored loosely; readers clamp it
    /// through `recorder::clamp_fps`, which is also what makes a value
    /// left over from a GIF preset harmless.
    #[serde(default = "default_video_fps")]
    pub video_fps: u32,
    /// Frame rate for GIF recordings. Separate from `video_fps` because
    /// GIF's usable range is much lower — see `domain::recorder`.
    #[serde(default = "default_gif_fps")]
    pub gif_fps: u32,
    /// Cap on the encoded frame's height. `0` (`recorder::RESOLUTION_SOURCE`)
    /// records at whatever was captured, which is the default: a
    /// recorder that quietly halves the resolution of a 4K demo would be
    /// making a quality decision the user never asked for.
    ///
    /// **One value across both formats**, unlike the frame rates. The
    /// rates are split because a number legal for MP4 is illegal for
    /// GIF; a height cap has no such problem — GIF's own pixel budget is
    /// tighter than any of these and simply wins (see
    /// `recorder::output_size`), so a shared setting cannot produce a
    /// value either format refuses.
    #[serde(default = "default_max_height")]
    pub max_height: u32,
    /// Sources composited over the recording — a webcam, a logo
    /// (ADR 0033). The list a session *starts* from; a recording preset
    /// can carry its own instead.
    ///
    /// Empty by default, which is every recording made before sources
    /// existed. A camera that only turns on when the user says so is
    /// the same privacy rule the microphone follows.
    #[serde(default)]
    pub sources: Vec<crate::composition::Source>,
    /// H.264 encoder settings a session starts from. Read-clamped by
    /// [`RecordingSettings::encoding`].
    ///
    /// A nested struct rather than five more flat fields, mirroring how
    /// `recorder::RecorderEncoding` groups them: they are read together
    /// and mean nothing individually. GIF ignores all of it.
    #[serde(default)]
    pub encoding: crate::recorder::RecorderEncoding,
    /// Composite the cursor into recorded frames. Ships off, matching
    /// the still-capture default.
    #[serde(default)]
    pub cursor: bool,
    /// Draw a border around the recorded area for the length of the
    /// session, once the overlay is gone.
    ///
    /// **Ships on.** Between choosing a region and stopping, nothing
    /// else on screen says what is being recorded — the overlay is
    /// down by design and the HUD sits in a corner. The outline is
    /// click-through and excluded from capture, so it costs the user
    /// nothing and never lands in the file; the option exists because a
    /// recording *of* a bordered area (a tutorial about Clippity, a
    /// screenshot of the screen) is the one case where it's noise.
    #[serde(default = "default_outline")]
    pub outline: bool,
    /// Put every finished clip on the clipboard as a file reference, so
    /// it can be pasted straight into a chat window.
    ///
    /// Ships **off**, matching `CaptureSettings::clipboard` — silently
    /// replacing whatever the user had copied is a surprise whichever
    /// pipeline does it. See `recorder::RecorderToggles::clipboard` for
    /// why this copies a path rather than the file's bytes.
    #[serde(default)]
    pub clipboard: bool,
}

fn default_outline() -> bool {
    true
}

fn default_video_fps() -> u32 {
    crate::recorder::MP4_FPS_DEFAULT
}

fn default_gif_fps() -> u32 {
    crate::recorder::GIF_FPS_DEFAULT
}

fn default_max_height() -> u32 {
    crate::recorder::RESOLUTION_SOURCE
}

fn default_gain_pct() -> u16 {
    crate::recorder::GAIN_PCT_DEFAULT
}

impl Default for RecordingSettings {
    fn default() -> Self {
        Self {
            microphone: false,
            system_audio: false,
            microphone_device: None,
            system_device: None,
            microphone_gain_pct: default_gain_pct(),
            system_gain_pct: default_gain_pct(),
            video_fps: default_video_fps(),
            gif_fps: default_gif_fps(),
            max_height: default_max_height(),
            sources: Vec::new(),
            encoding: crate::recorder::RecorderEncoding::default(),
            cursor: false,
            outline: default_outline(),
            clipboard: false,
        }
    }
}

impl RecordingSettings {
    /// Frame rate for `format`, clamped into that format's legal range.
    ///
    /// The clamp lives here rather than at the call site so a settings
    /// file edited by hand — or written by an older build with a
    /// different ceiling — can't start a session at a rate the encoder
    /// will refuse.
    pub fn fps_for(&self, format: crate::recorder::RecorderFormat) -> u32 {
        let requested = match format {
            crate::recorder::RecorderFormat::Mp4 => self.video_fps,
            crate::recorder::RecorderFormat::Gif => self.gif_fps,
        };
        crate::recorder::clamp_fps(Some(requested), format)
    }

    /// The output-height cap these settings describe, clamped. Same
    /// reasoning as [`Self::fps_for`]: read-clamping is what makes a
    /// hand-edited or older settings file harmless.
    pub fn max_height(&self) -> u32 {
        crate::recorder::clamp_max_height(self.max_height)
    }

    /// The encoder settings these settings describe, clamped.
    pub fn encoding(&self) -> crate::recorder::RecorderEncoding {
        self.encoding.clamped()
    }

    /// The source list these settings describe, capped and clamped.
    pub fn sources(&self) -> Vec<crate::composition::Source> {
        crate::composition::clamp_sources(self.sources.clone())
    }

    /// The audio selection these settings describe, gains clamped.
    pub fn audio(&self) -> crate::recorder::AudioSelection {
        crate::recorder::AudioSelection {
            microphone: self.microphone,
            system: self.system_audio,
            microphone_device: self.microphone_device.clone(),
            system_device: self.system_device.clone(),
            microphone_gain_pct: crate::recorder::clamp_gain_pct(self.microphone_gain_pct),
            system_gain_pct: crate::recorder::clamp_gain_pct(self.system_gain_pct),
        }
    }
}

#[cfg(test)]
mod recording_tests {
    use super::*;
    use crate::recorder::RecorderFormat;

    #[test]
    fn audio_ships_off_on_both_inputs() {
        // A recorder that starts listening to the room, or to whatever
        // is playing, the first time it is used is a privacy surprise.
        let d = RecordingSettings::default();
        assert!(!d.microphone);
        assert!(!d.system_audio);
        assert!(!d.audio().any());
    }

    #[test]
    fn both_inputs_ship_at_unity_gain() {
        let a = RecordingSettings::default().audio();
        assert_eq!(a.microphone_gain_pct, crate::recorder::GAIN_PCT_DEFAULT);
        assert_eq!(a.system_gain_pct, crate::recorder::GAIN_PCT_DEFAULT);
    }

    #[test]
    fn encoder_settings_ship_at_the_shipped_defaults() {
        let e = RecordingSettings::default().encoding();
        assert_eq!(e.quality, crate::recorder::RecorderQuality::Balanced);
        assert_eq!(e.bitrate_bps, None);
        assert!(e.prefer_hardware);
    }

    #[test]
    fn a_nonsense_encoding_is_read_clamped() {
        let s = RecordingSettings {
            encoding: crate::recorder::RecorderEncoding {
                keyframe_seconds: 0,
                bitrate_bps: Some(u32::MAX),
                ..Default::default()
            },
            ..Default::default()
        };
        let e = s.encoding();
        assert_eq!(
            e.keyframe_seconds,
            crate::recorder::KEYFRAME_SECONDS_DEFAULT
        );
        assert_eq!(e.bitrate_bps, Some(crate::recorder::BITRATE_MAX_BPS));
    }

    #[test]
    fn a_nonsense_gain_is_read_clamped() {
        let s = RecordingSettings {
            microphone_gain_pct: 5_000,
            system_gain_pct: 60,
            ..Default::default()
        };
        let a = s.audio();
        assert_eq!(a.microphone_gain_pct, crate::recorder::GAIN_PCT_MAX);
        assert_eq!(a.system_gain_pct, 60);
    }

    #[test]
    fn resolution_ships_at_the_captured_size() {
        // Silently halving the resolution of a 4K demo would be a
        // quality decision the user never made.
        assert_eq!(
            RecordingSettings::default().max_height(),
            crate::recorder::RESOLUTION_SOURCE
        );
    }

    #[test]
    fn a_nonsense_resolution_is_read_clamped() {
        let s = RecordingSettings {
            max_height: 99_999,
            ..Default::default()
        };
        assert_eq!(s.max_height(), crate::recorder::MAX_RESOLUTION_HEIGHT);
    }

    #[test]
    fn devices_default_to_following_the_os() {
        let d = RecordingSettings::default();
        assert_eq!(d.microphone_device, None);
        assert_eq!(d.system_device, None);
    }

    #[test]
    fn each_format_reads_its_own_rate() {
        let s = RecordingSettings {
            video_fps: 60,
            gif_fps: 12,
            ..Default::default()
        };
        assert_eq!(s.fps_for(RecorderFormat::Mp4), 60);
        assert_eq!(s.fps_for(RecorderFormat::Gif), 12);
    }

    #[test]
    fn an_out_of_range_stored_rate_is_clamped_on_read() {
        // A settings file edited by hand, or written by a build with a
        // different ceiling, must not start a session at a rate the
        // encoder refuses.
        let s = RecordingSettings {
            video_fps: 1_000,
            gif_fps: 1,
            ..Default::default()
        };
        assert_eq!(s.fps_for(RecorderFormat::Mp4), crate::recorder::MP4_FPS_MAX);
        assert_eq!(s.fps_for(RecorderFormat::Gif), crate::recorder::GIF_FPS_MIN);
    }

    #[test]
    fn the_audio_selection_carries_pinned_devices() {
        let s = RecordingSettings {
            microphone: true,
            microphone_device: Some("mic-1".into()),
            ..Default::default()
        };
        let audio = s.audio();
        assert!(audio.microphone);
        assert!(!audio.system);
        assert_eq!(audio.microphone_device.as_deref(), Some("mic-1"));
    }

    #[test]
    fn settings_without_a_recording_section_still_parse() {
        // Every settings file written before the recorder shipped has
        // no `recording` key; it must load as the defaults rather than
        // failing the whole file.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.recording, RecordingSettings::default());
    }

    #[test]
    fn the_section_round_trips_camel_case() {
        let json = serde_json::to_value(RecordingSettings::default()).unwrap();
        assert_eq!(json["systemAudio"], false);
        assert_eq!(json["videoFps"], MP4_FPS_DEFAULT_FOR_TEST);
        assert!(json["microphoneDevice"].is_null());
    }

    const MP4_FPS_DEFAULT_FOR_TEST: u32 = crate::recorder::MP4_FPS_DEFAULT;
}

/// Patch shape for `settings_update` — each section optional, replaces
/// the whole sub-struct when present. Mirrors the legacy ergonomics
/// (`update({ general })`) on a typed wire.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub general: Option<GeneralSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AppearanceSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notifications: Option<NotificationSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub performance: Option<PerformanceSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture: Option<CaptureSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording: Option<RecordingSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<ModelsSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcuts: Option<ShortcutsSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub developer: Option<DeveloperSettings>,
}

/// Hard upper bound for any per-kind toast duration. 60 s is the same
/// ceiling the legacy slider exposed (15 s) doubled twice — values
/// above this are almost certainly a bug or a typo, and would render
/// "indefinitely persistent" UX that the user already gets at `0 ms`.
pub const MAX_TOAST_DURATION_MS: u64 = 60_000;

/// Pure: `^#[0-9a-fA-F]{6}$`. The accent color is injected directly
/// into a CSS custom property — the service layer rejects anything
/// that wouldn't produce a parseable color value.
pub fn validate_accent_hex(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 7 || bytes[0] != b'#' {
        return false;
    }
    bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
}

/// Pure: clamp every duration to `MAX_TOAST_DURATION_MS`. `0` is
/// preserved as the "sticky" semantic.
pub fn clamp_durations(d: &mut ToastDurations) {
    d.color = d.color.min(MAX_TOAST_DURATION_MS);
    d.palette = d.palette.min(MAX_TOAST_DURATION_MS);
    d.clipboard = d.clipboard.min(MAX_TOAST_DURATION_MS);
    d.text = d.text.min(MAX_TOAST_DURATION_MS);
    d.recording = d.recording.min(MAX_TOAST_DURATION_MS);
    d.error = d.error.min(MAX_TOAST_DURATION_MS);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::toast::ToastDefaults;

    // ---------- defaults match legacy/toast hardcoded values ----------

    #[test]
    fn default_settings_match_toast_hardcoded_defaults() {
        let d = Settings::default();
        let t = ToastDefaults::defaults();
        assert_eq!(d.notifications.corner, t.corner);
        assert_eq!(d.notifications.durations, t.durations);
    }

    #[test]
    fn default_appearance_accent_is_clippity_coral() {
        assert_eq!(AppearanceSettings::default().accent, "#FF6E4A");
    }

    #[test]
    fn default_theme_pref_is_system() {
        assert_eq!(AppearanceSettings::default().theme, ThemePref::System);
    }

    #[test]
    fn default_appearance_extras_are_shipped_neutral() {
        let a = AppearanceSettings::default();
        assert_eq!(a.window_opacity, 100);
        assert_eq!(a.window_backdrop, WindowBackdrop::Mica);
        assert_eq!(a.ui_scale, 100);
        assert_eq!(a.corner_radius, RadiusScale::Default);
        assert_eq!(a.density, Density::Comfortable);
        assert_eq!(a.app_icon, AppIconStyle::Color);
    }

    #[test]
    fn appearance_extras_serialize_camel_and_kebab_case() {
        let s = serde_json::to_string(&Settings::default()).unwrap();
        assert!(s.contains("\"windowOpacity\""), "{s}");
        assert!(s.contains("\"windowBackdrop\""), "{s}");
        assert!(s.contains("\"uiScale\""), "{s}");
        assert!(s.contains("\"cornerRadius\""), "{s}");
        assert!(s.contains("\"density\""), "{s}");
        assert!(s.contains("\"appIcon\""), "{s}");
        // Enum variants are kebab-case on the wire.
        assert_eq!(
            serde_json::to_string(&RadiusScale::Round).unwrap(),
            "\"round\""
        );
        assert_eq!(
            serde_json::to_string(&Density::Compact).unwrap(),
            "\"compact\""
        );
        assert_eq!(
            serde_json::to_string(&AppIconStyle::Monochrome).unwrap(),
            "\"monochrome\""
        );
        assert_eq!(
            serde_json::to_string(&WindowBackdrop::Acrylic).unwrap(),
            "\"acrylic\""
        );
    }

    #[test]
    fn partial_appearance_section_fills_new_fields_from_default() {
        // A settings.json written before these knobs existed (knows only
        // theme/accent) must still parse, gaining the shipped neutral
        // defaults rather than erroring.
        let json = r##"{ "appearance": { "accent": "#123456" } }"##;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.appearance.accent, "#123456");
        assert_eq!(parsed.appearance.window_opacity, 100);
        assert_eq!(parsed.appearance.window_backdrop, WindowBackdrop::Mica);
        assert_eq!(parsed.appearance.ui_scale, 100);
        assert_eq!(parsed.appearance.corner_radius, RadiusScale::Default);
        assert_eq!(parsed.appearance.density, Density::Comfortable);
        assert_eq!(parsed.appearance.app_icon, AppIconStyle::Color);
    }

    #[test]
    fn appearance_extras_round_trip_through_json() {
        let mut s = Settings::default();
        s.appearance.window_opacity = 72;
        s.appearance.window_backdrop = WindowBackdrop::Tabbed;
        s.appearance.ui_scale = 115;
        s.appearance.corner_radius = RadiusScale::Sharp;
        s.appearance.density = Density::Compact;
        s.appearance.app_icon = AppIconStyle::Monochrome;
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn clamp_window_opacity_enforces_envelope() {
        assert_eq!(clamp_window_opacity(0), MIN_WINDOW_OPACITY_PCT);
        assert_eq!(clamp_window_opacity(80), 80);
        assert_eq!(clamp_window_opacity(200), MAX_WINDOW_OPACITY_PCT);
    }

    // ---------- backdrop tuning ----------

    #[test]
    fn default_backdrop_tuning_is_neutral_per_material() {
        let t = BackdropTuningSet::default();
        // Only Acrylic ships the alpha the tint used to be hardcoded
        // to; every material that ignores the tint stores 0 rather than
        // a number that looks meaningful and never does anything.
        assert_eq!(t.acrylic.tint_strength, 70);
        assert_eq!(t.mica.tint_strength, 0);
        assert_eq!(t.tabbed.tint_strength, 0);
        assert_eq!(t.blur.tint_strength, 0);
        assert_eq!(t.clear.tint_strength, 0);
        // Every scale knob is neutral so tuning changes nothing until
        // the user moves a slider.
        for tuning in [t.mica, t.acrylic, t.blur, t.tabbed, t.clear] {
            assert_eq!(tuning.glass_strength, 100);
            assert_eq!(tuning.blur_strength, 100);
            assert_eq!(tuning.saturation, 100);
        }
    }

    #[test]
    fn backdrop_tuning_clamps_every_knob() {
        let clamped = BackdropTuning::new(200, 250, 250, 5).clamped();
        assert_eq!(clamped.tint_strength, MAX_BACKDROP_TINT_PCT);
        assert_eq!(clamped.glass_strength, MAX_BACKDROP_GLASS_PCT);
        assert_eq!(clamped.blur_strength, MAX_BACKDROP_BLUR_PCT);
        assert_eq!(clamped.saturation, MIN_BACKDROP_SATURATION_PCT);
    }

    #[test]
    fn backdrop_tint_alpha_spans_the_byte_range() {
        assert_eq!(BackdropTuning::new(0, 100, 100, 100).tint_alpha(), 0);
        assert_eq!(BackdropTuning::new(100, 100, 100, 100).tint_alpha(), 255);
        // The shipped 70 % reproduces the alpha acrylic was pinned to.
        assert_eq!(BackdropTuning::default().tint_alpha(), 178);
        // Out-of-envelope input is clamped before the conversion, so it
        // can never wrap around the byte.
        assert_eq!(BackdropTuning::new(255, 100, 100, 100).tint_alpha(), 255);
    }

    #[test]
    fn backdrop_tuning_set_get_and_set_round_trip_per_material() {
        let mut set = BackdropTuningSet::default();
        let tuned = BackdropTuning::new(10, 20, 30, 150);
        set.set(WindowBackdrop::Blur, tuned);
        assert_eq!(set.get(WindowBackdrop::Blur), tuned);
        // Other materials untouched — the point of storing per material.
        assert_eq!(set.get(WindowBackdrop::Mica), default_untinted_tuning());
        assert_eq!(set.get(WindowBackdrop::Acrylic), BackdropTuning::default());
    }

    #[test]
    fn only_acrylic_and_blur_accept_a_tint() {
        assert!(WindowBackdrop::Acrylic.accepts_tint());
        assert!(WindowBackdrop::Blur.accepts_tint());
        assert!(!WindowBackdrop::Mica.accepts_tint());
        assert!(!WindowBackdrop::Tabbed.accepts_tint());
        assert!(!WindowBackdrop::Clear.accepts_tint());
    }

    #[test]
    fn wallpaper_materials_do_not_sample_live_content() {
        assert!(!WindowBackdrop::Mica.samples_live_content());
        assert!(!WindowBackdrop::Tabbed.samples_live_content());
        assert!(WindowBackdrop::Acrylic.samples_live_content());
        assert!(WindowBackdrop::Blur.samples_live_content());
        assert!(WindowBackdrop::Clear.samples_live_content());
    }

    #[test]
    fn clear_backdrop_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&WindowBackdrop::Clear).unwrap(),
            "\"clear\""
        );
    }

    #[test]
    fn partial_backdrop_tuning_fills_missing_materials_from_default() {
        // A settings.json written before `clear` existed, and with only
        // one knob set on `mica`, must still parse.
        let json = r##"{ "appearance": { "backdropTuning": {
            "mica": { "saturation": 140 }
        } } }"##;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        let t = parsed.appearance.backdrop_tuning;
        assert_eq!(t.mica.saturation, 140);
        assert_eq!(t.mica.glass_strength, 100);
        // `tintStrength` was absent from the object, so the per-field
        // serde default fills it — Mica ignores it either way.
        assert_eq!(t.mica.tint_strength, 70);
        assert_eq!(t.clear, default_untinted_tuning());
    }

    #[test]
    fn backdrop_tuning_round_trips_through_json() {
        let mut s = Settings::default();
        s.appearance.window_backdrop = WindowBackdrop::Clear;
        s.appearance
            .backdrop_tuning
            .set(WindowBackdrop::Clear, BackdropTuning::new(0, 35, 60, 130));
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"backdropTuning\""), "{json}");
        assert!(json.contains("\"glassStrength\""), "{json}");
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn clamp_ui_scale_enforces_envelope() {
        assert_eq!(clamp_ui_scale(10), MIN_UI_SCALE_PCT);
        assert_eq!(clamp_ui_scale(100), 100);
        assert_eq!(clamp_ui_scale(255), MAX_UI_SCALE_PCT);
    }

    #[test]
    fn default_general_captures_dir_is_empty() {
        assert!(GeneralSettings::default().captures_dir.is_empty());
    }

    #[test]
    fn default_general_onboarded_is_false() {
        assert!(!GeneralSettings::default().onboarded);
    }

    #[test]
    fn onboarded_round_trips_camel_case() {
        let mut s = Settings::default();
        s.general.onboarded = true;
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"onboarded\":true"), "{json}");
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert!(back.general.onboarded);
    }

    // ---------- serde round-trips ----------

    #[test]
    fn settings_round_trips_through_json() {
        let original = Settings::default();
        let s = serde_json::to_string(&original).unwrap();
        let back: Settings = serde_json::from_str(&s).unwrap();
        assert_eq!(original, back);
    }

    #[test]
    fn settings_uses_camel_case_keys() {
        let s = serde_json::to_string(&Settings::default()).unwrap();
        assert!(s.contains("\"capturesDir\""), "{s}");
        assert!(s.contains("\"startOnStartup\""), "{s}");
        assert!(s.contains("\"windowOpacity\""), "{s}");
    }

    // ---------- performance ----------

    #[test]
    fn default_performance_is_accelerated_frosted_balanced() {
        let p = PerformanceSettings::default();
        assert!(p.gpu_acceleration, "GPU accel should ship on");
        assert!(p.window_effects, "window effects should ship on");
        assert!(!p.reduced_animations, "reduced animations should ship off");
        assert_eq!(p.capture_compression, CaptureCompression::Balanced);
    }

    #[test]
    fn performance_uses_camel_case_keys() {
        let s = serde_json::to_string(&Settings::default()).unwrap();
        assert!(s.contains("\"gpuAcceleration\""), "{s}");
        assert!(s.contains("\"windowEffects\""), "{s}");
        assert!(s.contains("\"reducedAnimations\""), "{s}");
        assert!(s.contains("\"captureCompression\""), "{s}");
    }

    #[test]
    fn capture_compression_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&CaptureCompression::Balanced).unwrap(),
            "\"balanced\""
        );
        assert_eq!(
            serde_json::to_string(&CaptureCompression::Fast).unwrap(),
            "\"fast\""
        );
        assert_eq!(
            serde_json::to_string(&CaptureCompression::Small).unwrap(),
            "\"small\""
        );
    }

    #[test]
    fn performance_round_trips_through_json() {
        let mut s = Settings::default();
        s.performance.gpu_acceleration = false;
        s.performance.window_effects = false;
        s.performance.reduced_animations = true;
        s.performance.capture_compression = CaptureCompression::Small;
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn partial_performance_section_fills_missing_fields_from_default() {
        // A settings.json written by a build that only knew
        // gpuAcceleration must still parse — the other knobs fall back
        // to their (on/on/off/balanced) defaults rather than erroring.
        let json = r#"{ "performance": { "gpuAcceleration": false } }"#;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        assert!(!parsed.performance.gpu_acceleration);
        assert!(parsed.performance.window_effects);
        assert!(!parsed.performance.reduced_animations);
        assert_eq!(
            parsed.performance.capture_compression,
            CaptureCompression::Balanced
        );
    }

    // ---------- capture ----------

    #[test]
    fn default_capture_palette_count_is_six() {
        assert_eq!(CaptureSettings::default().palette_count, 6);
        assert_eq!(Settings::default().capture.palette_count, 6);
    }

    #[test]
    fn default_capture_options_ship_preview_on_rest_off() {
        let c = CaptureSettings::default();
        assert!(c.preview, "preview should ship on");
        assert!(!c.clipboard, "clipboard should ship off");
        assert!(!c.cursor, "cursor should ship off");
        assert!(!c.enhance, "enhance should ship off");
        assert!(!c.delay, "delay should ship off");
        assert_eq!(c.delay_seconds, DEFAULT_DELAY_SECONDS);
        assert_eq!(c.scroll_direction, ScrollDirection::Down);
    }

    #[test]
    fn capture_section_uses_camel_case_keys() {
        let s = serde_json::to_string(&Settings::default()).unwrap();
        assert!(s.contains("\"capture\""), "{s}");
        assert!(s.contains("\"paletteCount\""), "{s}");
        assert!(s.contains("\"preview\""), "{s}");
        assert!(s.contains("\"delaySeconds\""), "{s}");
        assert!(s.contains("\"scrollDirection\""), "{s}");
    }

    #[test]
    fn partial_capture_section_fills_missing_fields_from_default() {
        // A settings.json that predates the capture section (or knows the
        // section but not the newer fields) still parses with the shipped
        // defaults rather than erroring.
        let json = r#"{ "capture": { "paletteCount": 10 } }"#;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.capture.palette_count, 10);
        assert!(parsed.capture.preview, "missing preview → default on");
        assert!(!parsed.capture.clipboard);
        assert_eq!(parsed.capture.delay_seconds, DEFAULT_DELAY_SECONDS);
        assert_eq!(parsed.capture.scroll_direction, ScrollDirection::Down);
    }

    #[test]
    fn capture_round_trips_through_json() {
        let mut s = Settings::default();
        s.capture.palette_count = 10;
        s.capture.preview = false;
        s.capture.clipboard = true;
        s.capture.cursor = true;
        s.capture.enhance = true;
        s.capture.delay = true;
        s.capture.delay_seconds = 12;
        s.capture.scroll_direction = ScrollDirection::Right;
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn clamp_delay_seconds_enforces_envelope() {
        assert_eq!(clamp_delay_seconds(0), MIN_DELAY_SECONDS);
        assert_eq!(clamp_delay_seconds(5), 5);
        assert_eq!(clamp_delay_seconds(200), MAX_DELAY_SECONDS);
    }

    // ---------- models ----------

    #[test]
    fn default_models_settings_auto_download_on_registry_default_model() {
        let m = ModelsSettings::default();
        assert!(m.auto_download, "auto-download should ship on");
        assert_eq!(m.object_model, crate::models::DEFAULT_OBJECT_MODEL);
        assert_eq!(m.confidence, DEFAULT_CONFIDENCE_PCT);
    }

    #[test]
    fn models_section_uses_camel_case_keys() {
        let s = serde_json::to_string(&Settings::default()).unwrap();
        assert!(s.contains("\"models\""), "{s}");
        assert!(s.contains("\"autoDownload\""), "{s}");
        assert!(s.contains("\"objectModel\""), "{s}");
        assert!(s.contains("\"confidence\""), "{s}");
    }

    #[test]
    fn partial_models_section_fills_missing_fields_from_default() {
        // A settings.json from a build that predates the models section
        // (or knows only part of it) still parses with sane defaults.
        let json = r#"{ "models": { "autoDownload": false } }"#;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        assert!(!parsed.models.auto_download);
        assert_eq!(
            parsed.models.object_model,
            crate::models::DEFAULT_OBJECT_MODEL
        );
        assert_eq!(parsed.models.confidence, DEFAULT_CONFIDENCE_PCT);
    }

    #[test]
    fn models_round_trips_through_json() {
        let mut s = Settings::default();
        s.models.auto_download = false;
        s.models.object_model = "yolov10s".into();
        s.models.confidence = 40;
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn clamp_confidence_enforces_envelope() {
        assert_eq!(clamp_confidence(0), MIN_CONFIDENCE_PCT);
        assert_eq!(clamp_confidence(50), 50);
        assert_eq!(clamp_confidence(100), MAX_CONFIDENCE_PCT);
    }

    // ---------- shortcuts ----------

    #[test]
    fn default_shortcuts_ship_empty_overrides_enabled_global() {
        let s = ShortcutsSettings::default();
        assert!(s.overrides.is_empty(), "no overrides ship by default");
        assert_eq!(s.global_capture, "Mod+Shift+2");
        assert!(s.global_capture_enabled, "global hotkey ships on");
        assert_eq!(Settings::default().shortcuts, ShortcutsSettings::default());
    }

    #[test]
    fn shortcuts_section_uses_camel_case_keys() {
        let s = serde_json::to_string(&Settings::default()).unwrap();
        assert!(s.contains("\"shortcuts\""), "{s}");
        assert!(s.contains("\"globalCapture\""), "{s}");
        assert!(s.contains("\"globalCaptureEnabled\""), "{s}");
    }

    #[test]
    fn partial_shortcuts_section_fills_missing_fields_from_default() {
        // A settings.json that predates the section (or knows only part of
        // it) still parses, gaining the shipped defaults rather than erroring.
        let json = r#"{ "shortcuts": { "globalCaptureEnabled": false } }"#;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        assert!(parsed.shortcuts.overrides.is_empty());
        assert_eq!(parsed.shortcuts.global_capture, "Mod+Shift+2");
        assert!(!parsed.shortcuts.global_capture_enabled);
    }

    #[test]
    fn shortcuts_overrides_round_trip_through_json() {
        let mut s = Settings::default();
        s.shortcuts
            .overrides
            .insert("editor:select-all".into(), vec!["Mod+Shift+A".into()]);
        // An explicit empty vec is "deliberately unbound" and must survive.
        s.shortcuts
            .overrides
            .insert("library:trash-selection".into(), vec![]);
        s.shortcuts.global_capture = "Mod+Alt+3".into();
        s.shortcuts.global_capture_enabled = false;
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn shortcuts_overrides_serialize_in_stable_key_order() {
        // BTreeMap keeps the persisted JSON deterministic regardless of
        // insertion order — clean diffs, reproducible tests.
        let mut a = Settings::default();
        a.shortcuts
            .overrides
            .insert("editor:z".into(), vec!["Z".into()]);
        a.shortcuts
            .overrides
            .insert("editor:a".into(), vec!["A".into()]);
        let json = serde_json::to_string(&a.shortcuts.overrides).unwrap();
        assert!(
            json.find("editor:a").unwrap() < json.find("editor:z").unwrap(),
            "{json}"
        );
    }

    // ---------- developer ----------

    #[test]
    fn developer_mode_ships_off_behind_a_restart_expiry() {
        // The switch reveals destructive actions and payload logging —
        // it must not ship armed, and must not stay armed forever by
        // default once a user does arm it.
        let d = DeveloperSettings::default();
        assert!(!d.enabled);
        assert_eq!(d.expiry, DeveloperExpiry::Restart);
        assert!(d.confirm_destructive, "destructive confirm ships on");
        assert!(!d.command_timing, "payload timing is opt-in");
        assert!(d.redact_diagnostics, "a bundle is redacted by default");
    }

    #[test]
    fn disk_logging_ships_on_for_every_user_not_just_developers() {
        // The whole point of an exportable bundle is that the session
        // which produced the bug was recorded without anyone opting in.
        let d = DeveloperSettings::default();
        assert!(d.log_to_disk);
        assert_eq!(d.backend_log, LogLevel::Info);
        assert_eq!(d.frontend_log, LogLevel::Warn);
        assert_eq!(d.log_max_file_mb, DEFAULT_LOG_FILE_MB);
        assert_eq!(d.log_retain_files, DEFAULT_LOG_FILES);
    }

    #[test]
    fn developer_section_uses_camel_case_and_kebab_case_keys() {
        let s = serde_json::to_string(&Settings::default()).unwrap();
        assert!(s.contains("\"developer\""), "{s}");
        assert!(s.contains("\"backendLog\""), "{s}");
        assert!(s.contains("\"logToDisk\""), "{s}");
        assert!(s.contains("\"featureFlags\""), "{s}");
        assert_eq!(serde_json::to_string(&LogLevel::Warn).unwrap(), "\"warn\"");
        assert_eq!(
            serde_json::to_string(&DeveloperExpiry::Day).unwrap(),
            "\"day\""
        );
    }

    #[test]
    fn partial_developer_section_fills_missing_fields_from_default() {
        // A settings.json written before this section existed, or by a
        // build that knew only part of it, must not lose disk logging.
        let json = r#"{ "developer": { "enabled": true } }"#;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        assert!(parsed.developer.enabled);
        assert!(parsed.developer.log_to_disk);
        assert!(parsed.developer.confirm_destructive);
        assert_eq!(parsed.developer.backend_log, LogLevel::Info);
        assert_eq!(parsed.developer.expiry, DeveloperExpiry::Restart);
    }

    #[test]
    fn developer_round_trips_through_json() {
        let mut s = Settings::default();
        s.developer.enabled = true;
        s.developer.enabled_at_ms = 1_700_000_000_000;
        s.developer.expiry = DeveloperExpiry::Day;
        s.developer.backend_log = LogLevel::Trace;
        s.developer.frontend_log = LogLevel::Debug;
        s.developer.command_timing = true;
        s.developer
            .feature_flags
            .insert("capture.duplication".into(), false);
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn log_level_parses_loosely_and_falls_back_to_info() {
        assert_eq!(LogLevel::parse("TRACE"), LogLevel::Trace);
        assert_eq!(LogLevel::parse(" warning "), LogLevel::Warn);
        assert_eq!(LogLevel::parse("none"), LogLevel::Off);
        // A hand-edited file, or a frontend that sent something odd, is
        // never worth failing over.
        assert_eq!(LogLevel::parse("shout"), LogLevel::Info);
    }

    #[test]
    fn log_level_thresholds_order_by_severity() {
        assert!(LogLevel::Error.allows(LogLevel::Warn));
        assert!(LogLevel::Warn.allows(LogLevel::Warn));
        assert!(!LogLevel::Info.allows(LogLevel::Warn));
        assert!(!LogLevel::Trace.allows(LogLevel::Debug));
        assert!(LogLevel::Debug.allows(LogLevel::Trace));
    }

    #[test]
    fn log_level_off_neither_emits_nor_admits() {
        assert!(!LogLevel::Off.allows(LogLevel::Trace));
        assert!(!LogLevel::Error.allows(LogLevel::Off));
    }

    #[test]
    fn developer_read_clamps_its_loosely_stored_numbers() {
        let d = DeveloperSettings {
            log_max_file_mb: 0,
            log_retain_files: 9_999,
            slow_command_ms: 0,
            ..Default::default()
        };
        assert_eq!(d.log_max_bytes(), MIN_LOG_FILE_MB as u64 * 1024 * 1024);
        assert_eq!(d.retained_files(), MAX_LOG_FILES);
        assert_eq!(d.slow_command_ms(), MIN_SLOW_COMMAND_MS);
    }

    #[test]
    fn a_disabled_developer_mode_never_expires() {
        let d = DeveloperSettings::default();
        assert!(!developer_mode_expired(&d, 0));
    }

    #[test]
    fn restart_expiry_disarms_on_every_launch() {
        let d = DeveloperSettings {
            enabled: true,
            enabled_at_ms: 1_000,
            expiry: DeveloperExpiry::Restart,
            ..Default::default()
        };
        // Evaluated once per process, so "any time at all" means expired.
        assert!(developer_mode_expired(&d, 1_001));
    }

    #[test]
    fn never_expiry_survives_a_launch() {
        let d = DeveloperSettings {
            enabled: true,
            expiry: DeveloperExpiry::Never,
            ..Default::default()
        };
        assert!(!developer_mode_expired(&d, u64::MAX));
    }

    #[test]
    fn day_expiry_measures_from_when_it_was_armed() {
        let armed = 1_700_000_000_000;
        let d = DeveloperSettings {
            enabled: true,
            enabled_at_ms: armed,
            expiry: DeveloperExpiry::Day,
            ..Default::default()
        };
        assert!(!developer_mode_expired(&d, armed + DEVELOPER_DAY_MS - 1));
        assert!(developer_mode_expired(&d, armed + DEVELOPER_DAY_MS));
    }

    #[test]
    fn day_expiry_without_a_stamp_counts_as_expired() {
        // "We don't know when this was armed" must not read as "forever".
        let d = DeveloperSettings {
            enabled: true,
            enabled_at_ms: 0,
            expiry: DeveloperExpiry::Day,
            ..Default::default()
        };
        assert!(developer_mode_expired(&d, 1_700_000_000_000));
    }

    #[test]
    fn a_clock_that_went_backwards_does_not_expire_developer_mode() {
        // System clocks move. Saturating arithmetic means "armed in the
        // future" reads as 0 elapsed, not as a huge elapsed.
        let d = DeveloperSettings {
            enabled: true,
            enabled_at_ms: 2_000,
            expiry: DeveloperExpiry::Day,
            ..Default::default()
        };
        assert!(!developer_mode_expired(&d, 1_000));
    }

    #[test]
    fn missing_fields_fall_back_to_default_via_serde_default() {
        // Older settings.json that knew nothing about appearance/
        // notifications must still parse.
        let json = r#"{}"#;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(parsed, Settings::default());
    }

    #[test]
    fn extra_fields_are_ignored_silently() {
        // Newer settings.json with reserved sub-structs that don't
        // exist yet must still parse.
        let json = r#"{ "unknown": { "x": 1 }, "general": { "capturesDir": "/x" } }"#;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.general.captures_dir, "/x");
    }

    #[test]
    fn theme_pref_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&ThemePref::System).unwrap(),
            "\"system\""
        );
        assert_eq!(
            serde_json::to_string(&ThemePref::Light).unwrap(),
            "\"light\""
        );
    }

    // ---------- validate_accent_hex ----------

    #[test]
    fn validate_accent_hex_accepts_uppercase() {
        assert!(validate_accent_hex("#FF6E4A"));
    }

    #[test]
    fn validate_accent_hex_accepts_lowercase() {
        assert!(validate_accent_hex("#ff6e4a"));
    }

    #[test]
    fn validate_accent_hex_rejects_short_form() {
        // #RGB shortform is valid CSS but not Clippity's canonical form.
        assert!(!validate_accent_hex("#fff"));
    }

    #[test]
    fn validate_accent_hex_rejects_missing_hash() {
        assert!(!validate_accent_hex("FF6E4A"));
    }

    #[test]
    fn validate_accent_hex_rejects_non_hex() {
        assert!(!validate_accent_hex("#GG6E4A"));
    }

    #[test]
    fn validate_accent_hex_rejects_empty() {
        assert!(!validate_accent_hex(""));
    }

    // ---------- clamp_durations ----------

    #[test]
    fn clamp_durations_preserves_sane_values() {
        let mut d = ToastDurations::default();
        let original = d.clone();
        clamp_durations(&mut d);
        assert_eq!(d, original);
    }

    #[test]
    fn clamp_durations_caps_runaway_values() {
        let mut d = ToastDurations {
            error: 999_999,
            ..Default::default()
        };
        clamp_durations(&mut d);
        assert_eq!(d.error, MAX_TOAST_DURATION_MS);
    }

    #[test]
    fn clamp_durations_preserves_zero_sticky_semantic() {
        let mut d = ToastDurations {
            text: 0,
            ..Default::default()
        };
        clamp_durations(&mut d);
        assert_eq!(d.text, 0);
    }

    // ---------- SettingsPatch ----------

    #[test]
    fn patch_omits_unset_sections_when_serialized() {
        let p = SettingsPatch {
            general: Some(GeneralSettings::default()),
            ..Default::default()
        };
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"general\""));
        assert!(!s.contains("\"appearance\""), "{s}");
    }
}
