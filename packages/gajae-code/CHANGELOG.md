# Changelog

## [Unreleased]

## [0.16.4] - 2026-09-05

## [0.16.3] - 2026-09-04

## [0.16.2] - 2026-09-04

## [0.16.1] - 2026-09-03

## [0.16.0] - 2026-09-02

## [0.15.6] - 2026-08-30

## [0.15.5] - 2026-08-29

## [0.15.4] - 2026-08-29

## [0.15.3] - 2026-08-27

## [0.15.2] - 2026-08-25

## [0.15.1] - 2026-08-25

## [0.15.0] - 2026-08-22

## [0.14.2] - 2026-08-20

## [0.14.1] - 2026-08-18

## [0.14.0] - 2026-08-17

### Added
- `가재씨` is now installed alongside `gjc` as a Korean launcher alias, running Gajae-Code identically to `gjc` (#4363).

## [0.13.3] - 2026-08-15

## [0.13.2] - 2026-08-13

## [0.13.1] - 2026-08-11

## [0.12.21] - 2026-08-09

## [0.12.20] - 2026-08-09

## [0.12.19] - 2026-08-08

## [0.12.18] - 2026-08-08

## [0.12.17] - 2026-08-08

## [0.12.16] - 2026-08-08

### Added

- Added installation through the independently published `nightly` dist-tag (`bun install -g gajae-code@nightly`); stable installs remain on `latest`.

- Installed CLIs can now switch channels in place with `gjc update --channel nightly` / `--channel stable`, with the `startup.updateChannel` setting choosing the default channel.

## [0.12.15] - 2026-08-06

## [0.12.14] - 2026-08-06

## [0.12.13] - 2026-08-06

## [0.12.12] - 2026-08-05

## [0.12.11] - 2026-08-03

## [0.12.10] - 2026-08-03

## [0.12.8] - 2026-08-02

## [0.12.7] - 2026-07-31

## [0.12.6] - 2026-07-31

## [0.12.5] - 2026-07-30

## [0.12.4] - 2026-07-30

## [0.12.3] - 2026-07-30

## [0.12.2] - 2026-07-30

## [0.12.1] - 2026-07-29

## [0.7.5] - 2026-06-27

### Fixed

- Patch release bundling memory hotfixes: resume OOM cycle guards for session-tree traversal (#1193, #1195) and elision of runaway thinking-token loops (#1196), plus psmux session support (#1192), tmux window-title sanitization (#1198), and Codex history replay sanitization (#1199, #1200).

## [0.7.4] - 2026-06-27

### Fixed

- Fixed the `gajae-code` npm wrapper to invoke the `gjc` CLI through the global bin wrapper so global installs launch the CLI correctly.

## [0.5.1] - 2026-06-14

- Version aligned with the 0.5.1 monorepo release; no functional changes in this package.

## [0.5.0] - 2026-06-13

- Version aligned with the 0.5.0 monorepo release; no functional changes in this package.

## [0.4.5] - 2026-06-12

- Version aligned with the 0.4.5 monorepo release; no functional changes in this package.

## [0.4.4] - 2026-06-10

- Version aligned with the 0.4.4 monorepo release; no functional changes in this package.

## [0.4.0] - 2026-06-06

### Changed

- Released the GJC 0.4.0 CLI wrapper for the lockstep release.

## [0.2.2] - 2026-05-31

### Changed

- Released the GJC 0.2.2 CLI wrapper for the lockstep release.

## [0.2.1] - 2026-05-30

### Changed

- Released the GJC 0.2.1 CLI wrapper for the release-readiness patch.

## [0.2.0] - 2026-05-28

### Changed

- Released the GJC 0.2.0 CLI wrapper for the workflow/runtime contract hardening release.

## [0.1.3] - 2026-05-28

### Changed

- Released the current dev branch fixes with refreshed 0.1.3 package metadata.

## [0.1.2] - 2026-05-28

- Republished the wrapper with registry-resolved dependencies for one-line installs.
- Updated package metadata for the Gajae Code npm publication.

## [0.1.1] - 2026-05-28

- Added the unscoped `gajae-code` npm wrapper for one-line `gjc` installs.
