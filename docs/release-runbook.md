# Release runbook

Releases build from a tag; updates reach installed applications only when a
manifest is promoted. The two steps are deliberately separate, so a bad
build never reaches anyone automatically.

## Cutting a release

1. Bump the version in `Cargo.toml` and `src-tauri/tauri.conf.json`, commit,
   and push.
2. Create a signed tag `vX.Y.Z` and push it. The release workflow builds
   Windows, macOS and Linux artifacts for both architectures, signs each
   with the updater key, attaches build provenance and an SBOM, and
   publishes the release as a prerelease.
3. Confirm the artifact list on the release page and that each installer
   has a matching `.sig` file.

## Promoting an update

Run the Promote workflow with the released version and a channel. It
downloads that release's artifacts, assembles the manifest from the
detached signatures, and uploads `latest.json` (stable) or `beta.json`
(beta) to the fixed `updater` release, which is what installed
applications poll. A platform whose artifact or signature is missing is
omitted from the manifest rather than published broken.

## Rolling back

Rolling back never uninstalls anything: installed applications refuse to
move to a lower version.

1. Promote the last known good version again. This stops further clients
   from taking the bad update.
2. Fix the defect, cut a new version above the bad one, and promote that.

## Channels

The stable manifest is `latest.json`, the beta manifest is `beta.json`.
Machines on the beta channel take updates first and soak them; nothing is
promoted to stable until it has run on beta without new crash reports.

## Key custody

The updater signing key lives in the repository's CI secrets and in the
secret manager. Any principal able to read either can sign an update that
installed applications will accept, which is the residual risk recorded in
the threat model. The public key is committed in
`src-tauri/tauri.conf.json`; a change to it invalidates every previously
signed manifest and requires reinstallation rather than an update.
