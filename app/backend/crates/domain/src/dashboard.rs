//! Dashboard cross-window handoff types — pure, no I/O.
//!
//! The dashboard is the main window's internal-routing concept:
//! "Library" / "Editor" / "Settings" are views rendered inside one
//! window, not separate windows. A click on the library's Open-in-
//! editor button (which fires from the capture window) needs to (a)
//! show the main window and (b) tell it to switch view + load a
//! specific capture id.
//!
//! Doing this with a Tauri event has a startup race: if the main
//! window is shown for the first time, its React listener registers
//! AFTER the emit. So the handoff goes through a tiny AppState
//! stash instead: `request_dashboard_view` writes it, the dashboard
//! drains it on mount via `consume_pending_dashboard_view`.

use serde::{Deserialize, Serialize};

/// Which dashboard view the main window should render. Strings
/// (kebab-case via serde) so the frontend can union-type them with
/// a TypeScript literal without round-tripping through a numeric
/// enum.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DashboardView {
    Library,
    Editor,
    Settings,
    Presets,
    /// Large read/copy view of a single saved palette (the aux id rides
    /// in `DashboardRequest::capture_id`, same as Editor).
    Palette,
}

/// What `request_dashboard_view` stashes + `consume_pending_dashboard_view`
/// returns. `capture_id` is meaningful for `view = Editor` (the image to
/// load) and `view = Palette` (the palette aux entry to show) — every
/// other view ignores it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DashboardRequest {
    pub view: DashboardView,
    pub capture_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_serializes_kebab_case() {
        let s = serde_json::to_string(&DashboardView::Library).unwrap();
        assert_eq!(s, r#""library""#);
        let s = serde_json::to_string(&DashboardView::Editor).unwrap();
        assert_eq!(s, r#""editor""#);
        let s = serde_json::to_string(&DashboardView::Settings).unwrap();
        assert_eq!(s, r#""settings""#);
        let s = serde_json::to_string(&DashboardView::Presets).unwrap();
        assert_eq!(s, r#""presets""#);
        let s = serde_json::to_string(&DashboardView::Palette).unwrap();
        assert_eq!(s, r#""palette""#);
    }

    #[test]
    fn request_round_trips_camel_case() {
        let original = DashboardRequest {
            view: DashboardView::Editor,
            capture_id: Some("/tmp/captures/clippity-1.png".into()),
        };
        let s = serde_json::to_string(&original).unwrap();
        assert!(s.contains(r#""view":"editor""#));
        assert!(s.contains(r#""captureId":"/tmp/captures/clippity-1.png""#));
        let back: DashboardRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.view, DashboardView::Editor);
        assert_eq!(
            back.capture_id.as_deref(),
            Some("/tmp/captures/clippity-1.png")
        );
    }
}
