//! Visible-window attribution for capture file naming **and metadata**.
//!
//! Given front-to-back window rectangles and one or more captured
//! regions, pick the window whose visible area contributes the most
//! pixels to the capture. Windows in front occlude windows behind them,
//! matching what the screenshot actually contains more closely than raw
//! rectangle overlap.
//!
//! [`dominant_window`] returns the whole winning entry — title *and*
//! owning app — rather than just the title it originally answered with,
//! because `domain::metadata` records both and they must describe the
//! same window. Handing back one struct is what makes picking the title
//! from one window and the app from another unrepresentable.
//!
//! [`dominant_monitor`] answers the same question for displays, and is
//! the simpler half: monitors tile the desktop without overlapping, so
//! there is nothing to occlude and plain intersection area decides it.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowRect<'a> {
    pub title: &'a str,
    /// Friendly name of the owning application, or `""` when the
    /// process could not be resolved. Empty rather than `Option` so the
    /// caller decides what "unknown" means at the point it builds the
    /// metadata record (`domain::metadata` drops blanks).
    pub app: &'a str,
    pub rect: Rect,
}

/// A display's bounds in the same coordinate space as the capture
/// regions it is matched against. `name` is whatever the caller wants
/// recorded — `domain::metadata::monitor_label` has already formatted it
/// by the time it reaches here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MonitorRect<'a> {
    pub name: &'a str,
    pub rect: Rect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RectI {
    left: i64,
    top: i64,
    right: i64,
    bottom: i64,
}

impl RectI {
    fn from_rect(r: Rect) -> Self {
        Self {
            left: r.x as i64,
            top: r.y as i64,
            right: r.x as i64 + r.width as i64,
            bottom: r.y as i64 + r.height as i64,
        }
    }

    fn area(self) -> u64 {
        let width = (self.right - self.left).max(0) as u64;
        let height = (self.bottom - self.top).max(0) as u64;
        width * height
    }

    fn intersect(self, other: Self) -> Option<Self> {
        let left = self.left.max(other.left);
        let top = self.top.max(other.top);
        let right = self.right.min(other.right);
        let bottom = self.bottom.min(other.bottom);
        (right > left && bottom > top).then_some(Self {
            left,
            top,
            right,
            bottom,
        })
    }
}

/// The window contributing the most *visible* pixels to the capture,
/// or `None` when nothing overlaps it. `windows` must be front-to-back
/// (topmost first) — each entry occludes every entry after it.
pub fn dominant_window<'a>(
    windows: &[WindowRect<'a>],
    capture_regions: &[Rect],
) -> Option<WindowRect<'a>> {
    let capture_rects: Vec<RectI> = capture_regions
        .iter()
        .copied()
        .filter(|r| r.width > 0 && r.height > 0)
        .map(RectI::from_rect)
        .collect();
    if capture_rects.is_empty() {
        return None;
    }

    let mut blockers = Vec::with_capacity(windows.len());
    let mut best = None;
    let mut best_area = 0_u64;
    for window in windows {
        let window_rect = RectI::from_rect(window.rect);
        let visible_area: u64 = capture_rects
            .iter()
            .filter_map(|capture| window_rect.intersect(*capture))
            .map(|target| visible_area_after_blockers(target, &blockers))
            .sum();
        if visible_area > best_area {
            best_area = visible_area;
            best = Some(*window);
        }
        blockers.push(window_rect);
    }

    best
}

/// The display contributing the most pixels to the capture, or `None`
/// when nothing overlaps it.
///
/// No occlusion pass, unlike [`dominant_window`]: displays partition the
/// virtual desktop rather than stacking on it, so every pixel of a
/// monitor rect is its own and simple intersection area is the whole
/// answer. A selection dragged across the seam between two screens
/// records the one it mostly sits on — the honest answer for a single
/// field, and the same "largest visible contribution" rule the window
/// side uses, so the two never disagree about what "dominant" means.
///
/// Ties go to the earlier entry, which keeps the result stable for a
/// selection split exactly down the middle.
pub fn dominant_monitor<'a>(
    monitors: &[MonitorRect<'a>],
    capture_regions: &[Rect],
) -> Option<MonitorRect<'a>> {
    let capture_rects: Vec<RectI> = capture_regions
        .iter()
        .copied()
        .filter(|r| r.width > 0 && r.height > 0)
        .map(RectI::from_rect)
        .collect();
    if capture_rects.is_empty() {
        return None;
    }

    let mut best = None;
    let mut best_area = 0_u64;
    for monitor in monitors {
        let monitor_rect = RectI::from_rect(monitor.rect);
        let area: u64 = capture_rects
            .iter()
            .filter_map(|capture| monitor_rect.intersect(*capture))
            .map(RectI::area)
            .sum();
        if area > best_area {
            best_area = area;
            best = Some(*monitor);
        }
    }

    best
}

fn visible_area_after_blockers(target: RectI, blockers: &[RectI]) -> u64 {
    let mut pieces = vec![target];
    for blocker in blockers {
        let mut next = Vec::new();
        for piece in pieces {
            subtract_rect(piece, *blocker, &mut next);
        }
        if next.is_empty() {
            return 0;
        }
        pieces = next;
    }
    pieces.into_iter().map(RectI::area).sum()
}

fn subtract_rect(piece: RectI, blocker: RectI, out: &mut Vec<RectI>) {
    let Some(hit) = piece.intersect(blocker) else {
        out.push(piece);
        return;
    };

    if piece.top < hit.top {
        out.push(RectI {
            left: piece.left,
            top: piece.top,
            right: piece.right,
            bottom: hit.top,
        });
    }
    if hit.bottom < piece.bottom {
        out.push(RectI {
            left: piece.left,
            top: hit.bottom,
            right: piece.right,
            bottom: piece.bottom,
        });
    }
    if piece.left < hit.left {
        out.push(RectI {
            left: piece.left,
            top: hit.top,
            right: hit.left,
            bottom: hit.bottom,
        });
    }
    if hit.right < piece.right {
        out.push(RectI {
            left: hit.right,
            top: hit.top,
            right: piece.right,
            bottom: hit.bottom,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win<'a>(title: &'a str, rect: Rect) -> WindowRect<'a> {
        WindowRect {
            title,
            app: "",
            rect,
        }
    }

    #[test]
    fn picks_largest_visible_overlap() {
        let windows = [
            win(
                "Foreground",
                Rect {
                    x: 0,
                    y: 0,
                    width: 80,
                    height: 100,
                },
            ),
            win(
                "Background",
                Rect {
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                },
            ),
        ];
        let capture = [Rect {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        }];
        assert_eq!(
            dominant_window(&windows, &capture).map(|w| w.title),
            Some("Foreground")
        );
    }

    #[test]
    fn sums_multiple_capture_regions() {
        let windows = [
            win(
                "Left",
                Rect {
                    x: 0,
                    y: 0,
                    width: 50,
                    height: 50,
                },
            ),
            win(
                "Right",
                Rect {
                    x: 100,
                    y: 0,
                    width: 100,
                    height: 50,
                },
            ),
        ];
        let capture = [
            Rect {
                x: 0,
                y: 0,
                width: 50,
                height: 50,
            },
            Rect {
                x: 100,
                y: 0,
                width: 100,
                height: 50,
            },
        ];
        assert_eq!(
            dominant_window(&windows, &capture).map(|w| w.title),
            Some("Right")
        );
    }

    #[test]
    fn dominant_window_carries_the_apps_name_alongside_the_title() {
        // The metadata record names both, and they must describe the
        // same window — so attribution returns them together.
        let windows = [
            WindowRect {
                title: "Inbox",
                app: "Outlook",
                rect: Rect {
                    x: 0,
                    y: 0,
                    width: 80,
                    height: 100,
                },
            },
            WindowRect {
                title: "Desktop",
                app: "Explorer",
                rect: Rect {
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                },
            },
        ];
        let capture = [Rect {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        }];
        let winner = dominant_window(&windows, &capture).expect("a winner");
        assert_eq!(winner.title, "Inbox");
        assert_eq!(winner.app, "Outlook");
    }

    // ---------- monitor attribution ----------

    fn screens() -> [MonitorRect<'static>; 2] {
        // Two 1920×1080 displays side by side, the second to the right.
        [
            MonitorRect {
                name: "Display 1",
                rect: Rect {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            },
            MonitorRect {
                name: "Display 2",
                rect: Rect {
                    x: 1920,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            },
        ]
    }

    #[test]
    fn picks_the_screen_the_selection_sits_on() {
        let capture = [Rect {
            x: 2000,
            y: 100,
            width: 400,
            height: 300,
        }];
        assert_eq!(
            dominant_monitor(&screens(), &capture).map(|m| m.name),
            Some("Display 2")
        );
    }

    #[test]
    fn a_selection_across_the_seam_records_where_it_mostly_is() {
        // 300 px left of the seam, 700 px right of it.
        let capture = [Rect {
            x: 1620,
            y: 0,
            width: 1000,
            height: 500,
        }];
        assert_eq!(
            dominant_monitor(&screens(), &capture).map(|m| m.name),
            Some("Display 2")
        );
    }

    #[test]
    fn multi_area_rects_are_summed_across_screens() {
        // One small rect on Display 1, two larger ones on Display 2 —
        // the sum decides, not any single rect.
        let capture = [
            Rect {
                x: 0,
                y: 0,
                width: 600,
                height: 600,
            },
            Rect {
                x: 2000,
                y: 0,
                width: 400,
                height: 500,
            },
            Rect {
                x: 2500,
                y: 0,
                width: 400,
                height: 500,
            },
        ];
        assert_eq!(
            dominant_monitor(&screens(), &capture).map(|m| m.name),
            Some("Display 2")
        );
    }

    #[test]
    fn an_exact_tie_keeps_the_earlier_screen() {
        // Straddling the seam dead centre: stable rather than arbitrary.
        let capture = [Rect {
            x: 1420,
            y: 0,
            width: 1000,
            height: 500,
        }];
        assert_eq!(
            dominant_monitor(&screens(), &capture).map(|m| m.name),
            Some("Display 1")
        );
    }

    #[test]
    fn no_screens_and_no_regions_both_attribute_nothing() {
        let capture = [Rect {
            x: 0,
            y: 0,
            width: 10,
            height: 10,
        }];
        assert_eq!(dominant_monitor(&[], &capture), None);
        assert_eq!(dominant_monitor(&screens(), &[]), None);
        // A zero-area region is no region at all.
        assert_eq!(
            dominant_monitor(
                &screens(),
                &[Rect {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 100,
                }]
            ),
            None
        );
    }

    #[test]
    fn returns_none_without_overlap() {
        let windows = [win(
            "Elsewhere",
            Rect {
                x: 0,
                y: 0,
                width: 50,
                height: 50,
            },
        )];
        let capture = [Rect {
            x: 100,
            y: 100,
            width: 50,
            height: 50,
        }];
        assert_eq!(dominant_window(&windows, &capture), None);
    }
}
