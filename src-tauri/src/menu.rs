//! Native application menu bar for macOS (design system section 4.13). The
//! window is otherwise chromeless everywhere; macOS alone keeps the native
//! menu bar because it costs the window nothing and carries system services
//! (dictation, emoji, window management) users already expect there.
//!
//! Menu items that correspond to a product command carry that command's
//! registry id and dispatch through [`crate::ipc::MenuCommandInvoked`], so
//! the menu never reimplements behavior the command registry already owns.
//! Predefined items (About, Quit, Undo, Minimize, ...) are native system
//! actions with no registry equivalent and are never forwarded.

#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuEvent, MenuItemBuilder, SubmenuBuilder};
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Runtime};
#[cfg(target_os = "macos")]
use tauri_specta::Event;

#[cfg(target_os = "macos")]
use crate::ipc::MenuCommandInvoked;

/// Registry command ids reachable from the native menu bar. Each one must
/// name a command registered in the frontend's `CommandRegistry`
/// (`src/lib/features/surfaces.ts` and `workspace.ts`); a menu item whose id
/// stops matching a registered command becomes an inert click, never a
/// crash, because dispatch is a single string comparison in the frontend.
/// Kept compiled and tested on every platform even though only macOS
/// installs the menu that uses it, so the id list stays checkable in CI.
#[cfg_attr(
    not(any(test, target_os = "macos")),
    allow(dead_code, reason = "read only by the macOS-only menu installer")
)]
const MENU_COMMAND_IDS: &[&str] = &[
    "note.create",
    "vault.open",
    "note.save",
    "tab.new",
    "tab.close",
    "settings.open",
    "quick-switcher.open",
    "vault-search.open",
    "palette.open",
    "panel.sidebar.toggle",
    "panel.outline.toggle",
    "application.zoom-in",
    "application.zoom-out",
    "application.zoom-reset",
];

/// Builds and installs the native macOS menu bar.
///
/// # Errors
///
/// Returns an error if the platform menu APIs fail to build or install any
/// menu, submenu, or item.
#[cfg(target_os = "macos")]
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let app_name = app.package_info().name.clone();

    let app_menu = SubmenuBuilder::new(app, &app_name)
        .about(None)
        .separator()
        .item(&MenuItemBuilder::with_id("settings.open", "Settings…").build(app)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("note.create", "New Note")
                .accelerator("Cmd+N")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("vault.open", "Open Vault…").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("note.save", "Save")
                .accelerator("Cmd+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("tab.new", "New Tab")
                .accelerator("Cmd+T")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("tab.close", "Close Tab")
                .accelerator("Cmd+W")
                .build(app)?,
        )
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("quick-switcher.open", "Quick Switcher")
                .accelerator("Cmd+O")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("vault-search.open", "Search").build(app)?)
        .item(
            &MenuItemBuilder::with_id("palette.open", "Commands")
                .accelerator("Cmd+K")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("panel.sidebar.toggle", "Toggle Sidebar").build(app)?)
        .item(&MenuItemBuilder::with_id("panel.outline.toggle", "Toggle Outline").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("application.zoom-in", "Zoom In")
                .accelerator("Cmd+Plus")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("application.zoom-out", "Zoom Out")
                .accelerator("Cmd+-")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("application.zoom-reset", "Actual Size")
                .accelerator("Cmd+0")
                .build(app)?,
        )
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )?;
    app.set_menu(menu)?;
    Ok(())
}

/// Forwards a registry-backed menu item click to the frontend by id. Every
/// other menu event (predefined items, unrecognized ids) is ignored here:
/// predefined items are already fully handled natively before this runs.
#[cfg(target_os = "macos")]
#[allow(
    clippy::needless_pass_by_value,
    reason = "App::on_menu_event requires exactly Fn(&AppHandle<R>, MenuEvent)"
)]
pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let command = event.id().0.clone();
    if MENU_COMMAND_IDS.contains(&command.as_str()) {
        let _ = MenuCommandInvoked { command }.emit(app);
    }
}

#[cfg(test)]
mod tests {
    use super::MENU_COMMAND_IDS;

    #[test]
    fn menu_command_ids_are_unique() {
        let mut sorted = MENU_COMMAND_IDS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), MENU_COMMAND_IDS.len());
    }
}
