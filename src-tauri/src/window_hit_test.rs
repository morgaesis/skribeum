//! Pure geometry and decision logic for the Windows Maximize caption
//! button's native hit-testing (design system section 4.13): Windows 11
//! snap layouts appear on hover and hold only when `WM_NCHITTEST` reports
//! `HTMAXBUTTON` over the button's real screen rectangle. This module holds
//! the platform-independent half of that rule so it runs in unit tests on
//! every CI runner; `windows_chrome` supplies the real coordinates from a
//! window subclass and calls it, and only that module needs a Windows
//! session to confirm the snap-layout flyout itself actually appears.

use serde::{Deserialize, Serialize};

/// The Maximize caption button's rectangle in the same coordinate space
/// `WM_NCHITTEST` uses after `ScreenToClient`: physical pixels measured
/// from the client area's top-left corner. The webview reports this
/// whenever the button's layout changes, converting its own CSS-pixel
/// `getBoundingClientRect` through `devicePixelRatio` before it crosses the
/// IPC boundary, so this side never needs to know the window's DPI scale.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct MaximizeButtonRect {
    /// Left edge, physical pixels from the client area's left edge.
    pub x: f64,
    /// Top edge, physical pixels from the client area's top edge.
    pub y: f64,
    /// Width in physical pixels.
    pub width: f64,
    /// Height in physical pixels.
    pub height: f64,
}

impl MaximizeButtonRect {
    /// Whether `(x, y)` falls inside the rectangle. Half-open on the far
    /// edges, matching the usual `left <= p < right` convention so adjacent
    /// rectangles never both claim their shared edge.
    ///
    /// Only ever called (through [`should_report_maximize_button`]) from
    /// the Windows-only subclass in `windows_chrome`; kept compiled and
    /// unit tested on every platform so the geometry itself stays checkable
    /// in CI without a Windows session.
    #[cfg_attr(
        not(any(test, target_os = "windows")),
        allow(dead_code, reason = "read only by the Windows-only hit-test subclass")
    )]
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

/// Decides whether one `WM_NCHITTEST` query should report `HTMAXBUTTON`.
///
/// `baseline_is_plain_client` is the pass-through hit-test result the rest
/// of the window chain already computed (the webview's own subclass, then
/// the system default) before this override runs: only a plain client-area
/// result is ever replaced. Resize-border codes and anything else the
/// system already decided pass straight through, which is what keeps the
/// rest of the caption area's existing drag and edge-resize behavior
/// intact; this function never touches them.
///
/// Only ever called from the Windows-only subclass in `windows_chrome`;
/// kept compiled and unit tested on every platform so the decision itself
/// stays checkable in CI without a Windows session.
#[cfg_attr(
    not(any(test, target_os = "windows")),
    allow(dead_code, reason = "read only by the Windows-only hit-test subclass")
)]
pub fn should_report_maximize_button(
    baseline_is_plain_client: bool,
    rect: Option<MaximizeButtonRect>,
    cursor_x: f64,
    cursor_y: f64,
) -> bool {
    baseline_is_plain_client && rect.is_some_and(|rect| rect.contains(cursor_x, cursor_y))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn button() -> MaximizeButtonRect {
        MaximizeButtonRect {
            x: 100.0,
            y: 0.0,
            width: 46.0,
            height: 40.0,
        }
    }

    #[test]
    fn reports_the_button_only_inside_its_rectangle() {
        assert!(should_report_maximize_button(
            true,
            Some(button()),
            120.0,
            20.0
        ));
        assert!(!should_report_maximize_button(
            true,
            Some(button()),
            99.0,
            20.0
        ));
        assert!(!should_report_maximize_button(
            true,
            Some(button()),
            146.0,
            20.0
        ));
        assert!(!should_report_maximize_button(
            true,
            Some(button()),
            120.0,
            40.0
        ));
    }

    #[test]
    fn never_overrides_a_non_client_baseline() {
        // A resize-border or other non-client hit test the system already
        // computed is left exactly as is, even directly over the button's
        // tracked rectangle; only a plain client-area baseline is eligible.
        assert!(!should_report_maximize_button(
            false,
            Some(button()),
            120.0,
            20.0
        ));
    }

    #[test]
    fn never_reports_the_button_before_the_webview_supplies_a_rectangle() {
        assert!(!should_report_maximize_button(true, None, 120.0, 20.0));
    }

    #[test]
    fn rectangle_bounds_are_half_open() {
        let rect = button();
        assert!(rect.contains(rect.x, rect.y));
        assert!(rect.contains(rect.x + rect.width - 1.0, rect.y + rect.height - 1.0));
        assert!(!rect.contains(rect.x + rect.width, rect.y));
        assert!(!rect.contains(rect.x, rect.y + rect.height));
        assert!(!rect.contains(rect.x - 1.0, rect.y));
    }
}
