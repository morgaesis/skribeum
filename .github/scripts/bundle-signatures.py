"""Collect Tauri updater signatures into one release asset."""

import argparse
import json
import pathlib
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()

    signatures = {}
    for signature_path in sorted(pathlib.Path(arguments.directory).rglob("*.sig")):
        artifact_name = signature_path.name.removesuffix(".sig")
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
