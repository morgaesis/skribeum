//! Application diagnostics: the rotating log every build writes, and the IPC
//! boundary timing that makes a stalled command visible in it.
//!
//! The log lives in the operating system log directory, never inside a vault,
//! and is capped so it cannot grow without bound on a long-lived install.

use std::time::{Duration, Instant};

use tauri::Runtime;
use tauri::ipc::Invoke;
use tauri::plugin::TauriPlugin;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

/// Base name of the rotating application log.
const LOG_FILE_NAME: &str = "skribeum";
/// Bytes one log file may reach before the next rotation.
const MAX_LOG_FILE_SIZE: u128 = 4_000_000;
/// Rotations retained alongside the live file.
const RETAINED_LOG_FILES: usize = 3;
/// Environment variable that raises the log level for a diagnostic session.
const LEVEL_ENVIRONMENT_VARIABLE: &str = "SKRIBEUM_LOG";

/// Occupying the calling thread beyond this budget costs the user a visibly
/// dropped frame, so it is reported rather than merely traced.
const SLOW_COMMAND_BUDGET: Duration = Duration::from_millis(100);

/// The level filter for this run. `SKRIBEUM_LOG` accepts the standard level
/// names and raises verbosity for a user collecting a diagnostic log.
fn level_filter() -> log::LevelFilter {
    std::env::var(LEVEL_ENVIRONMENT_VARIABLE)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(log::LevelFilter::Info)
}

/// The logging plugin, writing the rotating file and mirroring to stderr for
/// a run started from a terminal.
#[must_use]
pub fn logging<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_log::Builder::new()
        .target(Target::new(TargetKind::LogDir {
            file_name: Some(LOG_FILE_NAME.to_owned()),
        }))
        .target(Target::new(TargetKind::Stderr))
        .max_file_size(MAX_LOG_FILE_SIZE)
        .rotation_strategy(RotationStrategy::KeepSome(RETAINED_LOG_FILES))
        .level(level_filter())
        .build()
}

/// Wraps an invoke handler so every command reports how long it held its
/// caller.
///
/// A synchronous command runs its whole body inside this span, so the measured
/// duration is the time it occupied the main thread and the budget warning
/// names a real frame stall. An asynchronous command only dispatches here, so
/// its span measures dispatch alone and stays quiet by design.
pub fn timed_invoke_handler<R: Runtime>(
    inner: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let command = invoke.message.command().to_owned();
        let started = Instant::now();
        let handled = inner(invoke);
        let elapsed = started.elapsed();
        if elapsed >= SLOW_COMMAND_BUDGET {
            log::warn!(
                "ipc command {command} held its caller for {} ms",
                elapsed.as_millis()
            );
        } else {
            log::debug!(
                "ipc command {command} completed in {} ms",
                elapsed.as_millis()
            );
        }
        handled
    }
}
