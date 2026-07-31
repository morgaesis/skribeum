"""Assembles a Tauri updater manifest from a downloaded release directory.

The manifest names, per platform, the artifact the updater installs and the
detached signature written beside it at build time. A platform whose
artifact or signature is missing is omitted rather than published with a
broken entry, and the run fails if nothing at all could be assembled.
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()

    directory = pathlib.Path(arguments.directory)
    platforms = {}
    for key, suffix in PLATFORMS.items():
        artifacts = sorted(directory.glob(f"*{suffix}"))
        if not artifacts:
            continue
        artifact = artifacts[0]
        signature = artifact.with_name(artifact.name + ".sig")
        if not signature.exists():
            print(f"no signature for {artifact.name}, omitting {key}", file=sys.stderr)
            continue
        platforms[key] = {
            "signature": signature.read_text().strip(),
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
