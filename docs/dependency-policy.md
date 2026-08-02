# Dependency policy

Skribeum declares direct dependencies at the latest stable release supported by
the application. An API that has not reached a stable release uses its latest
upstream prerelease. Declarations use a compatible SemVer range so patch and
minor updates can resolve without source edits. Svelte remains on major version
5 and Tauri packages remain on major version 2 because those majors define the
application architecture. Major updates land when the dependent toolchain and
the complete gate support them.

Exact versions and package-manager overrides require a reason beside the
declaration when the format permits comments, or in this document when it does
not. A safety pin also points to its upstream issue and reproduction. The
dependency refresh must rerun that reproduction before moving the pin.

The active package-manager constraints are:

- TypeScript remains on the latest version 6 release because `svelte-check`
  requires an additional compiler package and an experimental execution path
  for TypeScript 7.
- `@wdio/native-utils` overrides the older exact version requested by
  `@wdio/tauri-service` and is reviewed with each WebdriverIO refresh.
- `serialize-javascript` overrides Mocha's vulnerable version range with a
  release outside GHSA-qj8w-gfj5-8c6v and GHSA-5c6j-r48x-rmvq.

Refresh the complete Rust and JavaScript trees together at least once per month
and whenever Dependabot opens an alert. Check crates.io and `bun outdated`,
remove declarations with no source, configuration, or command consumer, update
requirements, and regenerate every lockfile before the resolved transitive
tree drifts far behind its direct requirements.

CI runs cargo-deny against advisories, bans, licenses, and sources. Vulnerable
Rust crates fail at every dependency depth, and `unsound = "all"` extends that
posture to transitive unsoundness reports. Reasoned advisory exceptions are
listed explicitly in `deny.toml`; an exception is not a remediation. CI also
runs `bun audit --audit-level=low`, so every reported JavaScript severity fails
the dependency gate.
