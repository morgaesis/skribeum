"""Prove legacy files and the signature bundle yield the same manifest."""

import json
import pathlib
import subprocess
import sys
import tempfile


SCRIPT_DIRECTORY = pathlib.Path(__file__).parent
FIXTURE = SCRIPT_DIRECTORY / "fixtures" / "release-v0.0.5.json"
BUILD_MANIFEST = SCRIPT_DIRECTORY / "build-manifest.py"
BUNDLE_SIGNATURES = SCRIPT_DIRECTORY / "bundle-signatures.py"


def build(
    fixture: dict,
    directory: pathlib.Path,
    output: pathlib.Path,
    signatures: pathlib.Path | None = None,
) -> dict:
    command = [
        sys.executable,
        str(BUILD_MANIFEST),
        "--version",
        fixture["version"],
        "--directory",
        str(directory),
        "--repository",
        fixture["repository"],
        "--tag",
        fixture["tag"],
        "--output",
        str(output),
    ]
    if signatures:
        command.extend(["--signatures", str(signatures)])
    subprocess.run(command, check=True)
    return json.loads(output.read_text())


def main() -> int:
    fixture = json.loads(FIXTURE.read_text())
    with tempfile.TemporaryDirectory() as temporary_directory:
        root = pathlib.Path(temporary_directory)
        legacy = root / "legacy"
        bundled = root / "bundled"
        legacy.mkdir()
        bundled.mkdir()

        for artifact_name in fixture["artifacts"]:
            (legacy / artifact_name).write_text(f"fixture for {artifact_name}\n")
            (bundled / artifact_name).write_text(f"fixture for {artifact_name}\n")
        for artifact_name, signature in fixture["signatures"].items():
            (legacy / f"{artifact_name}.sig").write_text(f"{signature}\n")

        signature_bundle = bundled / "updater-signatures.json"
        subprocess.run(
            [
                sys.executable,
                str(BUNDLE_SIGNATURES),
                "--directory",
                str(legacy),
                "--version",
                fixture["version"],
                "--output",
                str(signature_bundle),
            ],
            check=True,
        )
        legacy_manifest = build(fixture, legacy, root / "legacy.json")
        bundled_manifest = build(
            fixture,
            bundled,
            root / "bundled.json",
            signature_bundle,
        )

    if legacy_manifest != bundled_manifest:
        print("legacy and bundled signature sources produced different manifests", file=sys.stderr)
        return 1
    missing_platform = fixture["missing_platform"]
    if missing_platform in bundled_manifest["platforms"]:
        print(f"missing signature did not omit {missing_platform}", file=sys.stderr)
        return 1
    for platform, entry in bundled_manifest["platforms"].items():
        artifact_name = entry["url"].rsplit("/", 1)[-1]
        if entry["signature"] != fixture["signatures"][artifact_name]:
            print(f"signature changed for {platform}", file=sys.stderr)
            return 1

    print(
        "legacy and bundled signature sources produced identical manifests; "
        f"{missing_platform} was omitted"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
