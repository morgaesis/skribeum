# Continuous integration

## What runs when

Every event runs the platform-independent gates: the release-metadata script
tests, the MSRV build, the benchmark regression gate, gitleaks, `cargo-deny`
and the JavaScript audit. The `rust` and `e2e` jobs run over a platform matrix
that a preceding `matrix` job emits as JSON for the event, so both jobs are
defined once and the platform list is the only thing that varies.

| Event | `rust` and `e2e` platforms |
| --- | --- |
| Pull request | `ubuntu-24.04-arm` |
| Pull request labelled `full-matrix` | `ubuntu-latest`, `macos-latest`, `windows-latest` |
| Push to `main` | `ubuntu-latest`, `macos-latest`, `windows-latest` |

A pull request therefore finishes in about the time one Linux leg takes
instead of waiting on the slowest of three platforms. The two events cover
different Linux architectures deliberately: releases ship both `linux-x86_64`
and `linux-aarch64`, and between the pull-request leg and the `main` leg both
are exercised.

The benchmark regression gate is its own job pinned to `ubuntu-latest`. The
committed baselines under each crate's `benches/baselines/` are medians for the
Linux x64 runner class, so the comparison is only meaningful there, and the
benchmark crates carry no Tauri dependency, so that job needs neither the
WebKitGTK packages nor a frontend build.

## Running the full matrix before a merge

Add the `full-matrix` label to a pull request that touches platform-specific
behaviour: window chrome, native menus, the updater, filesystem path handling,
or anything reading the platform at runtime. Adding the label starts a run that
reads it, so no further push is needed.

## When `main` fails

A push to `main` that fails opens an issue labelled `broken-main` naming the
commit and linking each failing job. Further failures comment on the same
issue; a green push to `main` closes it. One open issue exists at a time, so
the label is a live answer to whether `main` is healthy.

The release workflow is triggered by a tag and does not consult this result. A
tag cut from a red tree ships the failure, so the open issue is resolved, by
fixing forward or reverting, before tagging.

## What a pull request no longer proves

Narrowing the pull-request matrix to Linux moves macOS and Windows results
after the merge. The classes of defect that used to surface before a merge, and
where they are answered now:

- **Line endings.** Covered everywhere. The Rust byte-equality corpus
  (`tests/corpus/bytes-lf.md`, `bytes-crlf.md`, `bytes-mixed-line-endings.md`,
  driven by `crates/skribeum-core/tests/line_ending_corpus.rs`), the buffer
  mapping tests in `tests/web/lineEndingMap.test.ts`, and the packaged
  end-to-end fixtures `crlf.md` and `mixed-endings.md` all supply CRLF, lone CR
  and mixed-terminator input on whatever platform the suite runs on.
- **Modifier chords.** Covered everywhere. The primary modifier is Control on
  Windows and Linux alike, so the Windows leg never exercised a chord the Linux
  leg does not. The one platform-varying branch is the macOS Command form, and
  `tests/web/registry.test.ts` drives `globalKeydownHandler` with an overridden
  platform string so both branches run in one process.
- **Window chrome and native menus.** Not covered off-platform.
  `tests/e2e/windowChrome.spec.ts` skips on macOS by construction, and the
  Windows hit-testing path for snap layouts has no non-Windows equivalent.
- **Bundling and installers.** Not covered off-platform. NSIS, WiX, DMG and
  code-signing behaviour exist only on their own runners, and only the release
  workflow builds them.
- **Path and filesystem semantics.** Partly covered. Case-insensitive
  filesystems, path length limits, reserved filenames and file-locking on
  delete or rename behave differently on macOS and Windows and are only
  answered by running there.

## Recovering the assurance locally

A macOS or Windows leg cannot be run on a Linux workstation at all, so nothing
local substitutes for them. The list above is the honest statement of what
merging without the full matrix risks.

Everything the Linux leg runs does run locally, and `lefthook` runs it on push.
The `rust` and `web` jobs are filtered by the file types being pushed and run in
parallel, so a push that touches one language pays for one of them:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked

bunx biome check .
bun run check
bun run test:web
```

On an eight-core Linux workstation with warm build and dependency caches, the
Rust job takes about a minute and the web job about eighty seconds, so a push
that changes both waits a little over a minute. A push after a dependency bump
or a toolchain change pays the recompile instead, which is several minutes; that
is the cost of the change, not of the hook.

The packaged end-to-end suite is not in the hook. It needs a debug build
carrying the WebDriver feature and a virtual display, and the suite itself takes
about nine minutes:

```sh
bun run build
bun tauri build --debug --no-bundle --features webdriver \
  --config src-tauri/tauri.webdriver.conf.json
xvfb-run -a bun run e2e
```

Run it before pushing a change to the editor, the vault, the shell or the
end-to-end fixtures. A hook long enough to be worth skipping teaches people to
skip hooks, which costs more than the suite catches.

Any later `cargo` command that builds the workspace without `--features
webdriver`, including `cargo test --workspace`, replaces the debug binary with
one carrying no embedded WebDriver server, and the next end-to-end run fails in
`onPrepare` with the server never becoming ready on its port. Repeat the
`tauri build` line above after such a command.
