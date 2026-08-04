//! Windows-only native chrome glue (design system section 4.13).
//!
//! A `comctl32` window subclass answers `WM_NCHITTEST` for the Maximize
//! caption button so Windows 11 snap layouts appear on hover and hold, and
//! handles the companion non-client mouse messages the pattern requires so
//! the button still highlights and activates correctly even though a real
//! `HTMAXBUTTON` hit test routes pointer input away from the webview
//! entirely. The real system window menu (Move, Size, and the rest
//! `GetSystemMenu` exposes) lives here too, for `ipc::window_show_system_menu`.
//!
//! The pure geometry and hit-test decision this module drives lives in
//! [`crate::window_hit_test`], which is compiled and unit tested on every
//! platform; nothing in that module needs a Windows session to verify. This
//! file is the thin, Windows-only glue around it and cannot be exercised
//! outside a real Windows 11 session: the snap-layout flyout appearing on
//! hover and hold, and the native system menu's Move and Size entries
//! actually moving and resizing the window, both need one to confirm.
//!
//! Every FFI call in this module needs `unsafe`, which the workspace denies
//! by default (`unsafe_code = "deny"` in the workspace lints); this file
//! opts back in for exactly the Windows glue that requires it, and nothing
//! outside it does.
#![allow(unsafe_code)]
// Small, deliberate casts between Win32's fixed-width message and hit-test
// constants and the pointer-sized types the FFI signatures use throughout
// this file; every value involved is a small non-negative constant or a
// screen coordinate that fits, so the conversions are lossless in practice.
#![allow(
    clippy::cast_possible_wrap,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use tauri::{Manager, Runtime, WebviewWindow};
use tauri_specta::Event;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMenu, HTCLIENT, HTMAXBUTTON, IsZoomed, PostMessageW, SW_MAXIMIZE,
    SW_RESTORE, SetForegroundWindow, ShowWindow, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenu,
    WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE,
    WM_NULL, WM_SYSCOMMAND,
};

use crate::ipc::MaximizeButtonHitState;
use crate::window_hit_test::{MaximizeButtonRect, should_report_maximize_button};

/// Arbitrary subclass id, unique within one window: `comctl32` chains
/// multiple subclasses by `(callback, id)` pairs, and this module installs
/// exactly one per window.
const SUBCLASS_ID: usize = 0x5352_4c42; // "SRLB": Skribeum's maximize-button hook.

/// Per-window native chrome state, kept alive by a strong reference this
/// module leaks into the subclass's reference data and reclaims on
/// `WM_NCDESTROY`, plus a second strong reference in [`registry`] so IPC
/// commands on any thread can reach it without touching the Win32 subclass
/// API themselves (`GetWindowSubclass` and friends must run on the window's
/// owning thread; ordinary Rust memory does not).
struct HookState {
    /// The Maximize button's last-reported rectangle, or `None` before the
    /// webview has reported one yet.
    rect: Mutex<Option<MaximizeButtonRect>>,
    /// Whether the cursor is currently over the button per the native hit
    /// test, mirrored to the webview so its highlight can track a hover the
    /// DOM itself never sees once the hit test answers for that area.
    hovered: AtomicBool,
    /// Whether the primary button is currently held down over the button.
    pressed: AtomicBool,
    /// Emits [`MaximizeButtonHitState`] to the webview. Boxed and type
    /// erased so the subclass callback, a plain `extern "system" fn` that
    /// cannot itself be generic over the Tauri runtime, stays free of a
    /// runtime type parameter.
    emit_hit_state: Box<dyn Fn(bool, bool) + Send + Sync>,
}

type HookRegistry = Mutex<HashMap<isize, Arc<HookState>>>;

fn registry() -> &'static HookRegistry {
    static REGISTRY: OnceLock<HookRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn registry_key(hwnd: HWND) -> isize {
    hwnd.0 as isize
}

/// Installs the subclass on `window`'s HWND. Called once, from application
/// setup on the main thread (the thread that owns the window, which
/// `SetWindowSubclass` requires).
pub fn install<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let app = window.app_handle().clone();
    let state = Arc::new(HookState {
        rect: Mutex::new(None),
        hovered: AtomicBool::new(false),
        pressed: AtomicBool::new(false),
        emit_hit_state: Box::new(move |hovered, pressed| {
            let _ = MaximizeButtonHitState { hovered, pressed }.emit(&app);
        }),
    });
    registry()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(registry_key(hwnd), Arc::clone(&state));

    // One strong reference travels into the subclass's reference data as a
    // raw pointer; `WM_NCDESTROY` below reclaims and drops it exactly once.
    let leaked = Arc::into_raw(state);
    // SAFETY: `hwnd` is a live top-level window owned by this thread for
    // the lifetime of the application; `leaked` is a valid `Arc` pointer
    // whose ownership transfers to the subclass callback, which either
    // reclaims it on `WM_NCDESTROY` or, on installation failure below, is
    // reclaimed immediately here instead.
    let installed =
        unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, leaked as usize) }
            .as_bool();
    if !installed {
        // SAFETY: `SetWindowSubclass` failed, so no callback will ever run
        // for `leaked`; reclaiming and dropping it here is the only path
        // left that frees it.
        drop(unsafe { Arc::from_raw(leaked) });
        registry()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&registry_key(hwnd));
        return Err("failed to install the window-chrome hit-test subclass".to_owned());
    }
    Ok(())
}

/// Reports the Maximize button's current rectangle from the webview,
/// keeping the native hit test in sync whenever the button's own layout
/// changes. A silent no-op before `install` has run for this window (for
/// example, a stray call during teardown) rather than an error: the
/// snap-layout affordance simply stays unavailable until a valid report
/// arrives.
pub fn set_maximize_button_rect<R: Runtime>(
    window: &tauri::Window<R>,
    rect: Option<MaximizeButtonRect>,
) {
    let Ok(hwnd) = window.hwnd() else { return };
    let Some(state) = registry()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&registry_key(hwnd))
        .cloned()
    else {
        return;
    };
    *state.rect.lock().unwrap_or_else(PoisonError::into_inner) = rect;
}

/// Shows the real Windows system menu (Move, Size, Minimize, Maximize or
/// Restore, Close, and Alt+Space's full vocabulary) at the cursor, and
/// forwards the chosen command back to the window exactly as a native
/// titlebar would.
pub fn show_system_menu<R: Runtime>(window: &tauri::Window<R>) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    // SAFETY: `hwnd` is the live window whose drag region was right-clicked.
    // `brevert = false` retrieves the window's own current system menu
    // rather than resetting it to the default, matching what a native
    // titlebar would show.
    let menu = unsafe { GetSystemMenu(hwnd, false) };
    if menu.0.is_null() {
        return Err("the window reported no system menu".to_owned());
    }
    // SAFETY: bringing the window to the foreground before tracking the
    // popup, and posting a benign message after, is Microsoft's documented
    // workaround for the popup failing to dismiss when the user's next
    // click lands on a different window; `hwnd` stays valid throughout.
    let _ = unsafe { SetForegroundWindow(hwnd) };
    let mut cursor = POINT::default();
    unsafe { GetCursorPos(&raw mut cursor) }.map_err(|error| error.to_string())?;
    // SAFETY: `TPM_RETURNCMD` makes the return value the chosen item's
    // command id instead of a success flag, so the popup never posts its
    // own `WM_COMMAND` and the id is forwarded explicitly below.
    let selected = unsafe {
        TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            cursor.x,
            cursor.y,
            None,
            hwnd,
            None,
        )
    };
    let _ = unsafe { PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0)) };
    let command_id = selected.0;
    if command_id != 0 {
        // SAFETY: forwards the chosen system-menu command back to the
        // window exactly as a native titlebar would: `WM_SYSCOMMAND` is
        // what actually performs Move, Size, Minimize, Maximize, Restore,
        // and Close.
        let _ = unsafe {
            PostMessageW(
                Some(hwnd),
                WM_SYSCOMMAND,
                WPARAM(command_id as usize),
                LPARAM(0),
            )
        };
    }
    Ok(())
}

fn toggle_maximize(hwnd: HWND) {
    // SAFETY: `hwnd` is the live window whose Maximize button was released.
    let zoomed = unsafe { IsZoomed(hwnd) }.as_bool();
    let command = if zoomed { SW_RESTORE } else { SW_MAXIMIZE };
    // SAFETY: same as above; `ShowWindow` is the standard way to toggle a
    // window's maximized state.
    let _ = unsafe { ShowWindow(hwnd, command) };
}

/// Splits the packed screen-coordinate point `WM_NCHITTEST` and the other
/// non-client mouse messages carry in `lParam` into `(x, y)`. Windows packs
/// two signed 16-bit values into the low 32 bits of `lParam` for these
/// messages, the same layout the standard `GET_X_LPARAM`/`GET_Y_LPARAM`
/// macros decode; the `windows` crate does not re-export those macros, so
/// this reproduces them directly.
fn nc_message_screen_point(lparam: LPARAM) -> (i32, i32) {
    let packed = lparam.0 as u32;
    let x = i32::from(packed as u16 as i16);
    let y = i32::from((packed >> 16) as u16 as i16);
    (x, y)
}

fn screen_to_client(hwnd: HWND, screen_x: i32, screen_y: i32) -> Option<(f64, f64)> {
    let mut point = POINT {
        x: screen_x,
        y: screen_y,
    };
    // SAFETY: `hwnd` is the live window this subclass is installed on;
    // `point` is a local, stack-allocated `POINT` the call writes into.
    let converted = unsafe { ScreenToClient(hwnd, &raw mut point) }.as_bool();
    converted.then(|| (f64::from(point.x), f64::from(point.y)))
}

fn handle_nc_hit_test(hwnd: HWND, wparam: WPARAM, lparam: LPARAM, state: &HookState) -> LRESULT {
    // SAFETY: forwards to the rest of the subclass chain and the system
    // default to compute the baseline hit-test result before deciding
    // whether to override it; this never mutates window state, and `hwnd`
    // stays valid for the call.
    let baseline = unsafe { DefSubclassProc(hwnd, WM_NCHITTEST, wparam, lparam) };
    let (screen_x, screen_y) = nc_message_screen_point(lparam);
    let Some((client_x, client_y)) = screen_to_client(hwnd, screen_x, screen_y) else {
        return baseline;
    };
    let rect = *state.rect.lock().unwrap_or_else(PoisonError::into_inner);
    let baseline_is_plain_client = baseline.0 == HTCLIENT as isize;
    if should_report_maximize_button(baseline_is_plain_client, rect, client_x, client_y) {
        return LRESULT(HTMAXBUTTON as isize);
    }
    baseline
}

fn handle_nc_mouse_move(wparam: WPARAM, state: &HookState) {
    let over_button = wparam.0 == HTMAXBUTTON as usize;
    let was_hovered = state.hovered.swap(over_button, Ordering::SeqCst);
    if over_button != was_hovered {
        (state.emit_hit_state)(over_button, state.pressed.load(Ordering::SeqCst));
    }
}

fn handle_nc_mouse_leave(state: &HookState) {
    let was_hovered = state.hovered.swap(false, Ordering::SeqCst);
    let was_pressed = state.pressed.swap(false, Ordering::SeqCst);
    if was_hovered || was_pressed {
        (state.emit_hit_state)(false, false);
    }
}

fn handle_nc_lbutton_down(wparam: WPARAM, state: &HookState) -> Option<LRESULT> {
    if wparam.0 != HTMAXBUTTON as usize {
        return None;
    }
    state.pressed.store(true, Ordering::SeqCst);
    (state.emit_hit_state)(true, true);
    Some(LRESULT(0))
}

fn handle_nc_lbutton_up(
    hwnd: HWND,
    wparam: WPARAM,
    lparam: LPARAM,
    state: &HookState,
) -> Option<LRESULT> {
    if wparam.0 != HTMAXBUTTON as usize {
        return None;
    }
    let was_pressed = state.pressed.swap(false, Ordering::SeqCst);
    let (screen_x, screen_y) = nc_message_screen_point(lparam);
    let still_over_button = screen_to_client(hwnd, screen_x, screen_y).is_some_and(|(x, y)| {
        state
            .rect
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some_and(|rect| should_report_maximize_button(true, Some(rect), x, y))
    });
    (state.emit_hit_state)(state.hovered.load(Ordering::SeqCst), false);
    if was_pressed && still_over_button {
        toggle_maximize(hwnd);
    }
    Some(LRESULT(0))
}

/// The subclass callback `comctl32` invokes for every message sent to the
/// window, chained with any other subclass already installed. Must be a
/// plain, non-generic `extern "system" fn`, per `SUBCLASSPROC`'s signature;
/// [`HookState`] carries the Tauri runtime dependency instead, through the
/// type-erased [`HookState::emit_hit_state`] closure.
unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    dwrefdata: usize,
) -> LRESULT {
    if msg == WM_NCDESTROY {
        registry()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&registry_key(hwnd));
        // SAFETY: reclaims the strong reference `install` leaked into
        // `dwrefdata`; `WM_NCDESTROY` fires exactly once, last, for a
        // destroyed window, so this is the subclass's one matching
        // `Arc::from_raw`.
        drop(unsafe { Arc::from_raw(dwrefdata as *const HookState) });
        // SAFETY: `hwnd` is still valid for the duration of this call.
        return unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
    }

    // SAFETY: for every message besides `WM_NCDESTROY` handled above,
    // `dwrefdata` is still the live pointer `install` leaked and nothing
    // has freed it yet, so borrowing through it is sound; the borrow does
    // not outlive this call.
    let state = unsafe { &*(dwrefdata as *const HookState) };

    match msg {
        WM_NCHITTEST => handle_nc_hit_test(hwnd, wparam, lparam, state),
        WM_NCMOUSEMOVE => {
            handle_nc_mouse_move(wparam, state);
            // SAFETY: `hwnd` stays valid for the call.
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }
        WM_NCMOUSELEAVE => {
            handle_nc_mouse_leave(state);
            // SAFETY: `hwnd` stays valid for the call.
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }
        WM_NCLBUTTONDOWN => handle_nc_lbutton_down(wparam, state).unwrap_or_else(|| {
            // SAFETY: `hwnd` stays valid for the call.
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }),
        WM_NCLBUTTONUP => {
            handle_nc_lbutton_up(hwnd, wparam, lparam, state).unwrap_or_else(|| {
                // SAFETY: `hwnd` stays valid for the call.
                unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
            })
        }
        // SAFETY: `hwnd` stays valid for the call.
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_packed_screen_point_from_lparam() {
        // Screen coordinates can be negative on a multi-monitor layout with
        // a monitor to the left of or above the primary one; both signed
        // 16-bit halves must round-trip.
        let packed = (300i16 as u16 as u32) | ((-40i16 as u16 as u32) << 16);
        assert_eq!(nc_message_screen_point(LPARAM(packed as isize)), (300, -40));
    }
}
