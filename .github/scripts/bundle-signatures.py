"""Collect Tauri updater signatures into one release asset.

Signature files are keyed by the name the artifact carries on the release
page. Most bundlers name their output fully (version and architecture in the
file name), but the macOS bundler writes a generic `<product>.app.tar.gz` for
every architecture and the uploader renames it. The same rename is applied
here, derived from the target triple in the signature's path, so two
architectures never collide and the manifest builder finds each signature
under the name the release actually serves.
"""

import argparse
import json
import pathlib
import re
import sys

TRIPLE_ARCH_TOKENS = {
    "aarch64-apple-darwin": "aarch64",
    "x86_64-apple-darwin": "x64",
}


def release_asset_name(signature_path: pathlib.Path, version: str) -> str | None:
    """The release asset name for a signature file, or None on ambiguity.

    Fully named artifacts keep their on-disk name. A generic macOS
    `<product>.app.tar.gz` becomes `<product>_<version>_<arch>.app.tar.gz`,
    matching the uploader's rename, with the architecture read from the
    target triple directory in the path.
    """
    artifact_name = signature_path.name.removesuffix(".sig")
    if not artifact_name.endswith(".app.tar.gz"):
        return artifact_name
    product = artifact_name.removesuffix(".app.tar.gz")
    if re.search(r"_(aarch64|x64)$", product):
        return artifact_name
    for part in signature_path.parts:
        arch = TRIPLE_ARCH_TOKENS.get(part)
        if arch is not None:
            return f"{product}_{version}_{arch}.app.tar.gz"
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--version", required=True, help="bare version, no leading v")
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()

    signatures = {}
    for signature_path in sorted(pathlib.Path(arguments.directory).rglob("*.sig")):
        artifact_name = release_asset_name(signature_path, arguments.version)
        if artifact_name is None:
            print(
                f"cannot resolve an architecture for {signature_path}",
                file=sys.stderr,
            )
            return 1
        if artifact_name in signatures:
            print(f"duplicate signature for {artifact_name}", file=sys.stderr)
            return 1
        signature = signature_path.read_text().strip()
        if not signature:
            print(f"empty signature for {artifact_name}", file=sys.stderr)
            return 1
        signatures[artifact_name] = signature

    if not signatures:
        print("no updater signatures found", file=sys.stderr)
        return 1

    pathlib.Path(arguments.output).write_text(
        json.dumps(signatures, indent=2, sort_keys=True) + "\n"
    )
    print(f"collected {len(signatures)} updater signatures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
