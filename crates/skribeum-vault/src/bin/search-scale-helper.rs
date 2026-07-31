//! Small stdin-controlled helper for `scripts/search-scale.ts`. Keeping the
//! clock in the script lets the Rust test suite stay fully deterministic.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use skribeum_vault::{RealFs, SearchIndex, Vault};

fn run() -> Result<(), String> {
    let mut arguments = std::env::args_os();
    let program = arguments
        .next()
        .unwrap_or_else(|| "search-scale-helper".into());
    let vault_root = arguments.next().ok_or_else(|| {
        format!(
            "usage: {} <vault-root> <app-data-dir>",
            PathBuf::from(program).display()
        )
    })?;
    let app_data_dir = arguments
        .next()
        .ok_or_else(|| "usage: search-scale-helper <vault-root> <app-data-dir>".to_owned())?;
    if arguments.next().is_some() {
        return Err("usage: search-scale-helper <vault-root> <app-data-dir>".to_owned());
    }

    let vault = Vault::open(&RealFs, &PathBuf::from(vault_root))
        .map_err(|error| format!("vault open failed: {error}"))?;
    let index = SearchIndex::open_in_app_data(&PathBuf::from(app_data_dir), vault.root())
        .map_err(|error| format!("search index open failed: {error}"))?;

    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    writeln!(stdout, "READY").map_err(|error| format!("stdout write failed: {error}"))?;
    stdout
        .flush()
        .map_err(|error| format!("stdout flush failed: {error}"))?;

    let mut command = String::new();
    BufReader::new(std::io::stdin())
        .read_line(&mut command)
        .map_err(|error| format!("stdin read failed: {error}"))?;
    if command.trim_end() != "build" {
        return Err("expected a single build command on stdin".to_owned());
    }

    let indexed = index
        .rebuild(&RealFs, &vault)
        .map_err(|error| format!("search rebuild failed: {error}"))?;
    writeln!(stdout, "BUILT {indexed}").map_err(|error| format!("stdout write failed: {error}"))?;
    stdout
        .flush()
        .map_err(|error| format!("stdout flush failed: {error}"))?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("search-scale-helper: {error}");
        std::process::exit(1);
    }
}
