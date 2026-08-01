"""Exercise changelog extraction and its publication guard."""

import pathlib
import subprocess
import sys
import tempfile


SCRIPT = pathlib.Path(__file__).parent / "release-notes.py"


def run(changelog: pathlib.Path, output: pathlib.Path, tag: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--changelog",
            str(changelog),
            "--tag",
            tag,
            "--repository",
            "morgaesis/skribeum",
            "--output",
            str(output),
        ],
        check=False,
        capture_output=True,
        text=True,
    )


def main() -> int:
    with tempfile.TemporaryDirectory() as temporary_directory:
        root = pathlib.Path(temporary_directory)
        changelog = root / "CHANGELOG.md"
        output = root / "release.md"
        changelog.write_text(
            "# Changelog\n\n"
            "## [Unreleased]\n\n- Future change.\n\n"
            "## [1.2.3] - 2026-08-01\n\n"
            "### Added\n\n- Published feature.\n\n"
            "## [1.2.2] - 2026-07-31\n\n- Earlier feature.\n"
        )

        success = run(changelog, output, "v1.2.3")
        if success.returncode != 0:
            print(success.stderr, file=sys.stderr)
            return 1
        body = output.read_text()
        if "Published feature" not in body or "Earlier feature" in body:
            print("release notes did not isolate the matching section", file=sys.stderr)
            return 1
        if "minisign -Vm CHECKSUM" not in body or "sha256sum" not in body:
            print("release notes omitted download verification commands", file=sys.stderr)
            return 1

        output.unlink()
        missing = run(changelog, output, "v9.9.9")
        if missing.returncode == 0 or output.exists():
            print("missing changelog section did not stop publication", file=sys.stderr)
            return 1
        if "has no section for v9.9.9" not in missing.stderr:
            print("missing-section error was not clear", file=sys.stderr)
            return 1

    print("release notes use the matching section and reject a missing section")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
