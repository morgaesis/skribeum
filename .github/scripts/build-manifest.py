"""Assembles a Tauri updater manifest from a downloaded release directory.

The manifest names, per platform, the artifact the updater installs and its
Tauri Ed25519 signature. New releases provide signatures in one JSON object;
adjacent signature files remain supported so older releases can be promoted.
A platform whose artifact or signature is missing is omitted rather than
published with a broken entry, and the run fails if nothing can be assembled.
"""

import argparse
import json
import pathlib
import sys

# Platform key to the artifact suffix the updater installs.
PLATFORMS = {
    "windows-x86_64": "_x64-setup.exe",
    "windows-aarch64": "_arm64-setup.exe",
    "darwin-x86_64": "_x64.app.tar.gz",
    "darwin-aarch64": "_aarch64.app.tar.gz",
    "linux-x86_64": "_amd64.AppImage",
    "linux-aarch64": "_aarch64.AppImage",
}


def read_signature_bundle(path: pathlib.Path) -> dict[str, str]:
    try:
        signatures = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read signature bundle {path}: {error}") from error
    if not isinstance(signatures, dict) or not all(
        isinstance(name, str) and isinstance(signature, str)
        for name, signature in signatures.items()
    ):
        raise ValueError(f"signature bundle {path} must map file names to strings")
    return signatures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--signatures",
        help="JSON object mapping artifact file names to Tauri signature strings",
    )
    arguments = parser.parse_args()

    directory = pathlib.Path(arguments.directory)
    signature_bundle = None
    if arguments.signatures:
        try:
            signature_bundle = read_signature_bundle(pathlib.Path(arguments.signatures))
        except ValueError as error:
            print(error, file=sys.stderr)
            return 1

    platforms = {}
    for key, suffix in PLATFORMS.items():
        artifacts = sorted(directory.glob(f"*{suffix}"))
        if not artifacts:
            continue
        artifact = artifacts[0]
        if signature_bundle is None:
            signature_path = artifact.with_name(artifact.name + ".sig")
            signature = (
                signature_path.read_text().strip() if signature_path.exists() else None
            )
        else:
            signature = signature_bundle.get(artifact.name)
        if not signature:
            print(f"no signature for {artifact.name}, omitting {key}", file=sys.stderr)
            continue
        platforms[key] = {
            "signature": signature,
            "url": (
                f"https://github.com/{arguments.repository}/releases/download/"
                f"{arguments.tag}/{artifact.name}"
            ),
        }

    if not platforms:
        print("no signed artifacts found; nothing to promote", file=sys.stderr)
        return 1

    manifest = {
        "version": arguments.version,
        "notes": f"Skribeum {arguments.version}",
        "pub_date": None,
        "platforms": platforms,
    }
    # The published date is the release's own; the updater accepts null.
    manifest.pop("pub_date")
    pathlib.Path(arguments.output).write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"assembled manifest for {len(platforms)} platforms")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
