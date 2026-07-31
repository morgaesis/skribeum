// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(debug_assertions)]
    skribeum_app_lib::mark_cold_start_main_entry();
    skribeum_app_lib::run();
}
