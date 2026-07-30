# Security policy

## Supported versions

Skribeum is pre-release software. Only the latest commit on `main` is
supported; there are no maintained release branches.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Security Advisories: open the
repository's Security tab and choose "Report a vulnerability". Do not open a
public issue for a security problem.

This project has a single maintainer working on a best-effort basis. Expect an
acknowledgment within 7 days. Fix timelines depend on severity and are agreed
in the advisory thread.

## Scope

The application is pre-alpha. It makes no end-to-end encryption claims, and no
part of the codebase has been audited. Findings about the build pipeline,
dependency supply chain, and the Tauri IPC surface are in scope. Findings that
assume features which do not exist yet (sync, encryption, collaboration) are
out of scope.

## Safe harbor

Good-faith security research on your own installations is welcome. If you make
a good-faith effort to comply with this policy while researching, we will not
pursue legal action over that research. Do not access data that is not yours,
degrade service for others, or publicly disclose an issue before a fix is
available.
