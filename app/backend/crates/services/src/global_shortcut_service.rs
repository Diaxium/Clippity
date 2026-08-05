//! OS-global capture hotkey — registration + press-routing helper.
//!
//! The `shortcuts.global_capture` accelerator opens the region-capture
//! overlay from anywhere, even when Clippity has no focused window. It's
//! registered through `tauri-plugin-global-shortcut` (the same plugin the
//! countdown strip uses for its Escape accelerator).
//!
//! This service owns *only* the capture accelerator: it remembers exactly
//! what it registered so it can unregister precisely that on the next
//! `apply` (never touching the countdown's Escape), and so the plugin's
//! shared handler in `lib.rs` can tell a capture press apart from Escape
//! via [`GlobalShortcutService::is_capture_shortcut`].
//!
//! The combo is stored in the frontend's `Mod+Shift+Key` notation (so the
//! Settings panel and the OS registration read one string) and translated
//! to a plugin `Shortcut` here by [`parse_combo`].

use std::str::FromStr;
use std::sync::Mutex;

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use clippity_domain::developer::ShortcutDiagnostics;
use clippity_domain::settings::ShortcutsSettings;

#[derive(Default)]
pub struct GlobalShortcutService {
    /// The capture accelerator currently registered with the OS, if any.
    /// Tracked so `apply` unregisters exactly what it registered and the
    /// plugin handler can route a press without re-deriving the combo.
    registered: Mutex<Option<Shortcut>>,
}

impl GlobalShortcutService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Re-register the global capture hotkey so it matches `shortcuts`.
    /// Unregisters the previously-registered accelerator first, then
    /// registers the new one when enabled + parseable. Best-effort — a
    /// parse or registration failure (e.g. another app already owns the
    /// combo) is logged, never fatal. Idempotent: calling it with an
    /// unchanged config re-registers the same accelerator.
    ///
    /// Must run on the main/event-loop thread (Tauri requirement) and NOT
    /// from inside the plugin's own shortcut handler — the handler holds
    /// the plugin's registry lock, and register/unregister re-lock it.
    pub fn apply(&self, app: &AppHandle, shortcuts: &ShortcutsSettings) {
        let mut slot = self.registered.lock().unwrap_or_else(|p| p.into_inner());

        if let Some(old) = slot.take() {
            let _ = app.global_shortcut().unregister(old);
        }

        if !shortcuts.global_capture_enabled {
            return;
        }
        let Some(shortcut) = parse_combo(&shortcuts.global_capture) else {
            if !shortcuts.global_capture.trim().is_empty() {
                tracing::warn!(
                    combo = %shortcuts.global_capture,
                    "global capture: unparseable combo — not registered"
                );
            }
            return;
        };
        // Escape (no modifiers) is owned by the countdown strip — never let
        // the capture hotkey shadow it and break countdown cancellation.
        if shortcut == Shortcut::new(None, Code::Escape) {
            tracing::warn!("global capture: Escape is reserved — not registering");
            return;
        }

        match app.global_shortcut().register(shortcut) {
            Ok(()) => *slot = Some(shortcut),
            Err(e) => tracing::warn!(
                combo = %shortcuts.global_capture,
                error = %e,
                "global capture: registration failed"
            ),
        }
    }

    /// Best-effort unregister of the current capture accelerator (leaves
    /// Escape alone). Used on shutdown paths; a no-op when nothing is
    /// registered.
    pub fn clear(&self, app: &AppHandle) {
        let mut slot = self.registered.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(old) = slot.take() {
            let _ = app.global_shortcut().unregister(old);
        }
    }

    /// True when `shortcut` is the capture accelerator currently
    /// registered — the plugin handler routes a matching press to the
    /// region overlay.
    pub fn is_capture_shortcut(&self, shortcut: &Shortcut) -> bool {
        let slot = self.registered.lock().unwrap_or_else(|p| p.into_inner());
        slot.as_ref() == Some(shortcut)
    }

    /// What the OS actually holds for the capture accelerator, and — when
    /// it holds nothing — why.
    ///
    /// "The hotkey stopped working" is one of the few complaints the app
    /// cannot answer from its own settings: the combo is stored, the
    /// user can see it, and the registration silently lost to another
    /// application. Settings → Advanced reports this so the answer is
    /// visible rather than buried in a log line from startup.
    pub fn status(&self, shortcuts: &ShortcutsSettings) -> ShortcutDiagnostics {
        let registered = self
            .registered
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some();
        let combo = shortcuts.global_capture.clone();
        let detail = if registered {
            None
        } else if !shortcuts.global_capture_enabled {
            Some("turned off in Settings → Shortcuts".to_string())
        } else if combo.trim().is_empty() {
            Some("no combo set".to_string())
        } else if parse_combo(&combo).is_none() {
            Some("the combo could not be parsed".to_string())
        } else {
            Some("the OS refused it — another application may already own it".to_string())
        };
        ShortcutDiagnostics {
            combo,
            registered,
            detail,
        }
    }
}

/// Translate a frontend-notation combo (`"Mod+Shift+2"`, `"Mod+Alt+R"`,
/// `"Ctrl+Shift+ArrowUp"`) into a plugin [`Shortcut`]. Returns `None` for
/// an empty combo or one with no recognizable main key.
///
/// `Mod` maps to Control on Windows/Linux and Super (⌘) on macOS,
/// matching the frontend's Ctrl⇄Cmd `Mod` collapse. Modifier-only combos
/// (no main key) are rejected — a global accelerator needs a key.
pub fn parse_combo(combo: &str) -> Option<Shortcut> {
    let mut mods = Modifiers::empty();
    let mut code: Option<Code> = None;

    for raw in combo.split('+') {
        let part = raw.trim();
        if part.is_empty() {
            continue;
        }
        match part.to_ascii_lowercase().as_str() {
            "mod" | "cmdorctrl" | "commandorcontrol" => {
                #[cfg(target_os = "macos")]
                {
                    mods |= Modifiers::SUPER;
                }
                #[cfg(not(target_os = "macos"))]
                {
                    mods |= Modifiers::CONTROL;
                }
            }
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "shift" => mods |= Modifiers::SHIFT,
            "alt" | "option" | "opt" => mods |= Modifiers::ALT,
            "cmd" | "command" | "super" | "meta" | "win" => mods |= Modifiers::SUPER,
            token => code = code_from_token(token),
        }
    }

    let code = code?;
    let mods = if mods.is_empty() { None } else { Some(mods) };
    Some(Shortcut::new(mods, code))
}

/// Map a single combo key token to a plugin [`Code`] by normalizing it to
/// its UI Events `code` name and parsing (`Code` implements `FromStr` over
/// those names — `"KeyA"`, `"Digit2"`, `"ArrowUp"`, `"Space"`, …).
fn code_from_token(token: &str) -> Option<Code> {
    let name = ui_code_name(token)?;
    Code::from_str(&name).ok()
}

/// A combo key token → its UI Events `code` name. Handles single letters
/// / digits, the named keys the frontend author-notation uses, punctuation
/// tokens, and `f1`–`f24`.
fn ui_code_name(token: &str) -> Option<String> {
    // Single ASCII letter / digit.
    if token.len() == 1 {
        let c = token.as_bytes()[0];
        if c.is_ascii_alphabetic() {
            return Some(format!("Key{}", c.to_ascii_uppercase() as char));
        }
        if c.is_ascii_digit() {
            return Some(format!("Digit{}", c as char));
        }
    }

    let named = match token {
        "space" | "spacebar" => "Space",
        "enter" | "return" => "Enter",
        "escape" | "esc" => "Escape",
        "tab" => "Tab",
        "backspace" => "Backspace",
        "delete" | "del" => "Delete",
        "up" | "arrowup" => "ArrowUp",
        "down" | "arrowdown" => "ArrowDown",
        "left" | "arrowleft" => "ArrowLeft",
        "right" | "arrowright" => "ArrowRight",
        "home" => "Home",
        "end" => "End",
        "pageup" | "pgup" => "PageUp",
        "pagedown" | "pgdn" => "PageDown",
        "insert" | "ins" => "Insert",
        "printscreen" | "prtsc" | "prtscr" => "PrintScreen",
        "=" | "plus" | "equal" => "Equal",
        "-" | "minus" => "Minus",
        "/" | "slash" => "Slash",
        "\\" | "backslash" => "Backslash",
        "[" | "bracketleft" => "BracketLeft",
        "]" | "bracketright" => "BracketRight",
        "," | "comma" => "Comma",
        "." | "period" => "Period",
        ";" | "semicolon" => "Semicolon",
        "'" | "quote" => "Quote",
        "`" | "backquote" => "Backquote",
        _ => {
            // f1..f24
            if let Some(n) = token.strip_prefix('f') {
                if let Ok(num) = n.parse::<u8>() {
                    if (1..=24).contains(&num) {
                        return Some(format!("F{num}"));
                    }
                }
            }
            return None;
        }
    };
    Some(named.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mod_shift_digit() {
        let s = parse_combo("Mod+Shift+2").unwrap();
        #[cfg(not(target_os = "macos"))]
        let expected = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Digit2);
        #[cfg(target_os = "macos")]
        let expected = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Digit2);
        assert_eq!(s, expected);
    }

    #[test]
    fn parses_single_letter_case_insensitively() {
        assert_eq!(parse_combo("r"), parse_combo("R"));
        assert_eq!(parse_combo("Mod+r").unwrap(), parse_combo("Mod+R").unwrap());
    }

    #[test]
    fn parses_named_and_punctuation_keys() {
        assert!(parse_combo("Mod+ArrowUp").is_some());
        assert!(parse_combo("Alt+Space").is_some());
        assert!(parse_combo("Mod+Shift+]").is_some());
        assert!(parse_combo("Ctrl+=").is_some());
        assert!(parse_combo("F5").is_some());
    }

    #[test]
    fn rejects_empty_and_modifier_only_combos() {
        assert!(parse_combo("").is_none());
        assert!(parse_combo("Mod+Shift").is_none());
        assert!(parse_combo("   ").is_none());
    }

    #[test]
    fn rejects_unknown_key_token() {
        assert!(parse_combo("Mod+Nonsense").is_none());
        assert!(parse_combo("F99").is_none());
    }
}
