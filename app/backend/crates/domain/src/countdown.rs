//! Countdown-feature domain types + pure rules.
//!
//! The countdown HUD is a single-window utility: a wide strip
//! anchored just above the OS taskbar that ticks from N seconds down
//! to 0 with a thin progress bar. The frontend owns the tick clock;
//! the backend only sizes/positions/shows/hides the window and emits
//! the starting seconds.
//!
//! Wire format: camelCase struct fields (`secondsRemaining`),
//! kebab-case event names (`clippity://countdown/start`).
//! The matching frontend type lives in
//! `services/tauri/clients/countdown.ts`.

use serde::{Deserialize, Serialize};

/// Sent on `start_countdown`. The frontend's capture-delay path picks
/// a positive integer; the service rejects 0 with a validation error
/// (a zero-second countdown would race with the show animation).
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CountdownRequest {
    pub seconds: u32,
}

/// Emitted on `clippity://countdown/start` after the window is
/// positioned + shown. The frontend uses `seconds` to seed the local
/// tick state and the progress bar's full-width starting point.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CountdownStartEvent {
    pub seconds: u32,
}

/// Strip height in logical pixels. Tall enough for the 60 px numeral
/// (spec: 48–72 px) to sit above the progress line with breathing
/// room, and short enough that the strip never blocks more than a
/// thumb's worth of vertical space at the bottom of the screen. The
/// window is click-through anyway (`set_ignore_cursor_events`), so a
/// taller transparent strip never costs the user any interaction.
pub const COUNTDOWN_HEIGHT_LOGICAL: u32 = 96;

/// Upper bound on `seconds`. The capture-window stepper today caps at
/// 10; we accept up to a minute so a future port (e.g. presentations,
/// long screencasts) doesn't have to widen the contract.
pub const MAX_COUNTDOWN_SECONDS: u32 = 60;

/// Pure: validate the inbound request before the service touches any
/// Tauri APIs. Rejects 0 (the show animation would outrun the tick)
/// and the obviously-typo "1 hour, set by accident" case.
pub fn validate_request(req: CountdownRequest) -> Result<CountdownRequest, &'static str> {
    if req.seconds == 0 {
        return Err("countdown seconds must be >= 1");
    }
    if req.seconds > MAX_COUNTDOWN_SECONDS {
        return Err("countdown seconds above the supported maximum");
    }
    Ok(req)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trips_camel_case() {
        let r = CountdownRequest { seconds: 5 };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"seconds\":5"));
        let back: CountdownRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn start_event_round_trips_camel_case() {
        let e = CountdownStartEvent { seconds: 3 };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"seconds\":3"));
    }

    #[test]
    fn validate_request_accepts_one() {
        assert_eq!(
            validate_request(CountdownRequest { seconds: 1 }).unwrap(),
            CountdownRequest { seconds: 1 }
        );
    }

    #[test]
    fn validate_request_rejects_zero() {
        let err = validate_request(CountdownRequest { seconds: 0 }).unwrap_err();
        assert_eq!(err, "countdown seconds must be >= 1");
    }

    #[test]
    fn validate_request_rejects_over_max() {
        let err = validate_request(CountdownRequest { seconds: 999 }).unwrap_err();
        assert_eq!(err, "countdown seconds above the supported maximum");
    }
}
