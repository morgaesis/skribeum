mod common;

use std::process::Command;

use skribeum_vault::{FileSystem, RealFs};

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_skribeum-import"))
}

#[test]
fn help_describes_the_complete_notion_command() {
    let output = binary()
        .arg("notion")
        .arg("--help")
        .output()
        .expect("CLI runs");
    assert!(output.status.success(), "help exits successfully");
    let stdout = String::from_utf8(output.stdout).expect("help is UTF-8");
    for expected in ["<ARCHIVE>", "--out <DIR>", "--dry-run", "--force"] {
        assert!(
            stdout.contains(expected),
            "help omits '{expected}':\n{stdout}"
        );
    }
}

#[test]
fn dry_run_prints_the_plan_and_touches_nothing() {
    let temp = tempfile::tempdir().expect("temporary directory creates");
    let archive = temp.path().join("pages.zip");
    let output_path = temp.path().join("vault");
    common::archive_from_tree("pages", &archive);

    let output = binary()
        .arg("notion")
        .arg(&archive)
        .arg("--out")
        .arg(&output_path)
        .arg("--dry-run")
        .output()
        .expect("CLI runs");
    assert!(output.status.success(), "dry run succeeds");
    assert_eq!(
        String::from_utf8(output.stdout).expect("stdout is UTF-8"),
        "Plan: 8 files, 1 collision, 4 link rewrites\n"
    );
    assert!(
        RealFs.metadata(&output_path).is_err(),
        "dry run must not create the output directory"
    );
}

#[test]
fn rerun_requires_force_and_collision_names_are_stable() {
    let temp = tempfile::tempdir().expect("temporary directory creates");
    let archive = temp.path().join("pages.zip");
    let output_path = temp.path().join("vault");
    common::archive_from_tree("pages", &archive);

    let first = binary()
        .arg("notion")
        .arg(&archive)
        .arg("--out")
        .arg(&output_path)
        .output()
        .expect("first import runs");
    assert!(first.status.success(), "first import succeeds");

    let second = binary()
        .arg("notion")
        .arg(&archive)
        .arg("--out")
        .arg(&output_path)
        .output()
        .expect("second import runs");
    assert!(!second.status.success(), "second import requires force");
    assert!(
        String::from_utf8(second.stderr)
            .expect("stderr is UTF-8")
            .contains("pass --force"),
        "error explains how to rerun"
    );

    let forced = binary()
        .arg("notion")
        .arg(&archive)
        .arg("--out")
        .arg(&output_path)
        .arg("--force")
        .output()
        .expect("forced import runs");
    assert!(forced.status.success(), "forced rerun succeeds");
    assert!(
        RealFs.metadata(&output_path.join("Twin.md")).is_ok(),
        "first collision target exists"
    );
    assert!(
        RealFs.metadata(&output_path.join("Twin (2).md")).is_ok(),
        "second collision target exists"
    );
}
