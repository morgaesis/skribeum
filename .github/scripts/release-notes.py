"""Build a release body from the matching Keep a Changelog section."""

import argparse
import pathlib
import re
import sys


HEADING = re.compile(r"^## \[([^]]+)](?:\s+-\s+.+)?\s*$")


def changelog_section(changelog: pathlib.Path, tag: str) -> str:
    version = tag.removeprefix("v")
    lines = changelog.read_text().splitlines()
    section_start = None

    for index, line in enumerate(lines):
        match = HEADING.match(line)
        if match and match.group(1) == version:
            section_start = index + 1
            break

    if section_start is None:
        raise ValueError(
            f"{changelog} has no section for {tag}; add "
            f"'## [{version}] - YYYY-MM-DD' before publishing"
        )

    section_end = len(lines)
    for index in range(section_start, len(lines)):
        if lines[index].startswith("## "):
            section_end = index
            break

    section = "\n".join(lines[section_start:section_end]).strip()
    if not section:
        raise ValueError(f"{changelog} section for {tag} is empty")
    return section


def verification_notes(repository: str, tag: str) -> str:
    return f"""## Verify a download

Download `CHECKSUM`, `CHECKSUM.sig`, and the artifact to the same directory.
The following commands obtain the updater public key from this tag, verify the
signature over the checksum manifest, and check every downloaded artifact
listed in it:

```sh
curl -fsSLo tauri.conf.json \\
  https://raw.githubusercontent.com/{repository}/{tag}/src-tauri/tauri.conf.json
python3 -c 'import base64,json; print(base64.b64decode(json.load(open("tauri.conf.json"))["plugins"]["updater"]["pubkey"]).decode(), end="")' \\
  > skribeum.pub
minisign -Vm CHECKSUM -x CHECKSUM.sig -p skribeum.pub
sha256sum --ignore-missing --check CHECKSUM
```

The binaries are not code-signed or notarized. The signed checksum manifest
authenticates the downloads with Skribeum's updater key. GitHub build
provenance attestations provide a separate record and can be checked with:

```sh
gh attestation verify ./ARTIFACT --repo {repository}
```"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--changelog", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()

    try:
        section = changelog_section(pathlib.Path(arguments.changelog), arguments.tag)
    except ValueError as error:
        print(f"release notes error: {error}", file=sys.stderr)
        return 1

    body = f"{section}\n\n{verification_notes(arguments.repository, arguments.tag)}\n"
    pathlib.Path(arguments.output).write_text(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
