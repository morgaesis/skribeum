# Continuous integration

## Caching

The only cache in continuous integration is the cargo cache, applied by
`Swatinem/rust-cache` to the `rust`, `msrv` and `e2e` jobs. Nothing else is
cached, and the sections below give the numbers behind each of those choices
so that a future change starts from measurement rather than from intuition.

The scarce resource is not bandwidth. It is the repository's cache quota:
GitHub allows 10 GB per repository and evicts entries by least recent access
once that is passed. The cargo caches alone are 0.5 GB to 2 GB each, one per
job per operating system per CPU architecture, so the quota is the constraint
that decides what may be cached at all.

### What the cargo cache costs and returns

Sizes and step durations, measured across runs of this workflow:

| Cache entry | Size | Restore | Save |
| --- | --- | --- | --- |
| `rust`, Linux x64 | 2.0 GB | 28-49 s | 23-25 s |
| `rust`, Windows x64 | 1.2 GB | 38-80 s | 83-129 s |
| `rust`, macOS arm64 | 1.1-1.4 GB | 18-52 s | 31-46 s |
| `e2e`, Linux x64 | 0.8-0.9 GB | 13-20 s | 13-14 s |
| `e2e`, Windows x64 | 0.6-0.7 GB | 26-38 s | 41-48 s |
| `e2e`, macOS arm64 | 0.5-0.6 GB | 12-25 s | 25-34 s |
| `msrv`, Linux x64 | 0.7-0.9 GB | 20-30 s | 13-15 s |

The save column is the cost when the entry is rewritten. An exact key match
skips the save entirely and costs 0 s, which is the common case: over 56
measured restores there were no misses, 35 exact matches and 21 prefix
matches. A prefix match happens when `Cargo.lock`, a `Cargo.toml`, the
toolchain file or the cargo configuration changed, since those inputs are
hashed into the key.

What the restore buys, measured as the sum of the cargo steps in a job:

| Job | Exact match | Prefix match | Cold |
| --- | --- | --- | --- |
| `rust`, Linux x64 | 48-64 s | 159 s | — |
| `rust`, Windows x64 | 132-164 s | 238-269 s | — |
| `rust`, macOS arm64 | 55-106 s | 134-185 s | — |
| `rust`, Linux arm64 | — | — | 400 s |
| `e2e` debug build, Linux x64 | 21-28 s | 34-44 s | — |
| `e2e` debug build, Linux arm64 | — | — | 138 s |

A cold job pays several minutes; a restore costs tens of seconds. The cargo
cache wins, and it wins by enough that protecting it is worth more than any
additional cache is worth adding.

### Saving only from the default branch

The `save-if` condition on each `Swatinem/rust-cache` step restricts the save
to runs on `main`. Every event still restores.

A cache written from a pull request is scoped to that pull request's merge
ref. No other pull request can read it, and the pull request that wrote it
could have read the default-branch entry under the same key anyway, because
the action strips the workspace crates before saving and keeps only
third-party dependencies. The written entry is therefore a duplicate of one
that already exists, unreadable by anything else, and it counts against the
quota. Left unrestricted, a single cache key was observed stored three times,
1.2 GB each, and the repository sat at 12.0 GB against its 10 GB limit with a
third of that being such duplicates.

Exceeding the quota is what makes the cache stop paying: eviction takes the
least recently accessed entry, and the entries a pull request restores from
are the default-branch ones. Evicting one costs every subsequent pull request
a cold compile, which the table above prices at several minutes; the only
thing the restriction costs is that a pull request which itself changes
`Cargo.lock` re-resolves that change on each push instead of once, worth about
90 s on the `rust` job.

The condition is written inline at each of the three steps rather than once as
a workflow variable. The action hashes into the cache key every environment
variable whose name begins with `RUST`, `CARGO`, `CC`, `CFLAGS`, `CXX` or
`CMAKE`, values included, so a variable holding a per-event condition changes
the key per event: pull requests would key apart from the branch they restore
from and never hit. The same trap applies to any variable added to `ci.yml`
under one of those prefixes.

### Runner classes and cache keys

The cache key includes the operating system and the CPU architecture, so an
arm64 and an x86-64 runner never share an entry and a cross-architecture hit
cannot happen.

The consequence is a rule for the platform matrix: a runner class used on pull
requests must also run on `main`, or its cache is never written where a pull
request can read it and every pull request on that class compiles cold. A
Linux arm64 leg restoring from a Linux x64 default branch gets nothing; that
is the 400 s column in the table above.

### The forced rebuild in the end-to-end job

The `e2e` job touches `src-tauri/build.rs` and `src-tauri/src/lib.rs` before
building. `tauri::generate_context!` embeds the configuration at macro
expansion time, and the end-to-end build supplies a configuration overlay that
turns on `withGlobalTauri`; a cached build script would keep the previously
embedded configuration and produce a binary the WebDriver provider cannot
attach to, without failing the build. The rebuild it forces is inside the
21-28 s the warm debug build costs, so the correctness it buys is not paid for
in any figure worth recovering.

### What is not cached

**The apt WebKitGTK packages.** The Linux jobs install 189 packages, 61.5 MB
downloaded and 267 MB installed, in 27-42 s: about 5 s refreshing indexes,
19 s downloading and 13 s unpacking. A cache entry would be roughly 100 MB per
architecture and per package set, so up to four entries, and the ceiling on
what it could return is around 25 s per job. Against a quota that a cargo
entry loss prices at several minutes of cold compilation, the trade is
negative.

**The Bun module store and `node_modules`.** `bun install --frozen-lockfile`
takes 1-4 s on Linux and 5-6 s on macOS, which leaves nothing to recover. It
takes 59-82 s on Windows, but only about 8 s of that is fetching: against a
private store, a cold install measures 12.0 s and a warm one 4.1 s. The rest
is writing 29,749 files into a 668 MB tree, which a restored cache also has to
write, on a runner where 587 MB restores in 29 s and 1.2 GB saves in
83-129 s.

**The Vite build.** `bun run build` takes 3-5 s.

**The debug application binary, between the `rust` and `e2e` jobs.** There is
nothing to hand over. The `rust` job never builds the binary the end-to-end
job runs: that one compiles with `--features webdriver` against the WebDriver
configuration overlay.

**WebDriver binaries.** Nothing downloads them. The WebDriver server is
compiled into the debug binary by the `webdriver` feature and the provider
attaches to it directly, so the absence of `tauri-driver` and
`WebKitWebDriver` on the runner is expected and reported as a warning.

**Anything in the release workflow.** A run triggered by a tag can restore
only entries written for that same tag or for the default branch. The default
branch holds nothing a release leg could use: cache keys carry the job
identifier, and four of the six legs run in a pinned Debian container or on
runner classes that continuous integration never uses. Left in place, each leg
found no cache, then spent 16-66 s writing one that only a re-run of the same
tag could read, 235 s across the matrix and several gigabytes of quota per
release.

## Local verification before pushing

Local pre-push verification runs the repository's own commands through the git
hooks configured in `lefthook.yml`. It uses the toolchain that is installed,
which is the same toolchain the gates use, and it costs no container image.

`act` is not part of this, and running the `rust` job under it shows why.

It runs Linux containers only. Given a platform map that points the macOS and
Windows entries at a Linux image, it runs those legs in that image, where
`runner.os` reports `Linux`: the steps guarded by `runner.os == 'Linux'` run
on all three legs, and a leg labelled macOS or Windows can report success
having exercised nothing platform-specific. Without such a map it skips those
legs outright. Either way the platforms that a Linux-only pull request does
not cover are the platforms `act` cannot cover either.

Its runner image is not GitHub's. It is 1.7 GB, carries less preinstalled
tooling, and resolves 216 apt packages where a hosted runner resolves 189, so
a step can pass in one and fail in the other. Installing the WebKitGTK
packages takes 3 to 4.75 minutes in the container against 27-42 s on a hosted
runner.

Its concurrency model produces false failures. The matrix legs share one
machine rather than getting a runner each, and under that contention the web
test suite failed on all three legs with three different sets of tests, 3, 4
and 8 of them, every one of them a timeout rather than an assertion, on a
suite that passes in full when run directly. Eleven and a half minutes in, no
leg had reached a cargo step.

`act` answers one question well: whether a workflow file parses and its jobs,
conditions and step ordering are what the author intended. Reach for it to
debug workflow syntax, not to decide whether a change is correct.
