# Changelog

## [Unreleased]

## [0.11.8] - 2026-07-23

### Fixed

- Restricted the local dashboard API to its exact loopback authority and same-origin browser requests, with POST-only bounded session sync.

## [0.11.7] - 2026-07-22

### Fixed

- Compiled dashboard assets now remain in a validated in-memory archive map instead of being materialized in a predictable shared temporary cache.

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

- Refreshed stats package metadata for the GJC 0.4.0 release.

## [0.2.2] - 2026-05-31

### Changed

- Refreshed stats package metadata for the GJC 0.2.2 release.

## [0.2.1] - 2026-05-30

### Changed

- Refreshed stats package metadata for the GJC 0.2.1 release.

## [0.2.0] - 2026-05-28

### Changed

- Refreshed stats package metadata for the GJC 0.2.0 release.

## [0.1.3] - 2026-05-28

### Changed

- Released the current dev branch fixes with refreshed 0.1.3 package metadata.

## [0.1.2] - 2026-05-28

### Changed

- Updated package metadata for the Gajae Code npm publication.

## [0.1.1] - 2026-05-28

### Changed

- Bound the stats dashboard server explicitly to `127.0.0.1` so the local usage dashboard remains loopback-only by default.

## [15.1.6] - 2026-05-19

### Fixed

- Fixed `gjc stats` crashing on first session sync in published `gjc-{linux,darwin,windows}-*` binaries with `BuildMessage: ModuleNotFound resolving "./packages/stats/src/sync-worker.ts"`; the release build script now lists the stats sync, browser tab, and JS eval workers as explicit `--compile` entrypoints so Bun emits them into bunfs, matching the dev build script and the AGENTS.md worker spawn contract. ([#1150](https://github.com/can1357/gajae-code/issues/1150))

## [15.1.0] - 2026-05-15

### Fixed

- Fixed incremental `parseSessionFile(path, fromOffset)` losing the active service tier when resuming past a `service_tier_change` entry, so priority OpenAI replies appended after the offset are now credited with `premiumRequests: 1` (regression introduced by 13f59162e which stopped folding priority-tier into per-message premium counts)

## [15.0.1] - 2026-05-14
### Breaking Changes

- Raised the minimum required Bun version to >=1.3.14 in package metadata

### Changed

- Changed the "Premium Reqs" dashboard card to also include OpenAI priority service-tier requests (`serviceTier: "priority"`), counting each as 1 premium request alongside GitHub Copilot premium calls. Pre-existing sessions are backfilled on the next `gjc stats` run: a one-shot `premium_requests_priority_v1` sentinel wipes `file_offsets` so every session re-parses, and `insertMessageStats` now `UPSERT`s `premium_requests` (other columns untouched) using the `service_tier_change` entries already in the session log to retroactively credit priority traffic.

## [14.9.9] - 2026-05-12

### Added

- Added separate input-token and output-token totals to the overview dashboard cards.

### Fixed

- Fixed `gjc stats` in compiled binaries by using the serial sync path instead of spawning a raw file-asset worker that cannot import bundled parser code.
- Fixed behavior backfills after failed compiled-binary sync attempts by marking the backfill sentinel only after a successful full sync.

## [14.9.7] - 2026-05-12
### Breaking Changes

- Broke backward compatibility of behavior stats fields by replacing `yellingSentences`/`dramaRuns` with `yelling`/`anguish` and adding `negation`, `repetition`, `blame` in query result types and persisted `user_messages` schema

### Added

- Added `SyncOptions` to `syncAllSessions` with `onProgress` and `workers` to optionally show per-file sync progress and tune parser concurrency
- Added new frustration behavior metrics (`negation`, `repetition`, `blame`) plus a `frustration` aggregate in behavior charts, model tables, and summary cards

### Changed

- Changed sync ingestion to parse session files through a worker pool while applying parsed results and database writes on the main thread
- Changed behavior analysis to strip code blocks, XML/URLs, quoted lines, and placeholders before scoring and to suppress signals on long structured messages
- Changed dashboard metrics labels and totals to the new signal names, including replacing the old three-signal totals with `yelling`, `profanity`, `anguish`, and `frustration`
- Changed sync output to print a live terminal progress indicator while processing session files

### Fixed

- Fixed user-message attribution so assistant model/provider links are backfilled during incremental sync instead of being left unknown
- Fixed word-boundary regex handling in profanity detection so matching now works as intended in normal prose

## [14.9.5] - 2026-05-12

### Added

- Added time range selection options (1h, 24h, 7d, 30d, 90d, All) to the dashboard header and bound them to reloading statistics for the selected window
- Added a **Behavior** dashboard page that tracks user yelling (CAPS), profanity, and dramatic punctuation (`!!!` / `???`) per day, with by-model comparisons mirroring the cost page
- Added a per-model behavior table to the **Behavior** page mirroring the Models table: sortable rows of CAPS / profanity / drama hits per model with sparkline trend and an expandable per-model breakdown chart
- Added optional `range` query parameter support on stats endpoints to retrieve metrics scoped to a requested time window

### Changed

- Changed the Costs dashboard summary to report totals, average per day, and top model for the selected time range instead of a fixed 30-day window and removed the previous-30-day trend comparison
- Changed behavior metrics ingestion to compute yelling from user message sentence-level uppercase ratios, filtering out short uppercase fragments so the behavior data is attributed to messages more accurately
- Removed per-chart 14/30/90 day pickers on Costs and Behavior pages so every page obeys the single time-range selector in the header
- Changed dashboard and stats queries to return data from the selected time window instead of always using all-time aggregates
- Changed the default displayed range in the UI/API to last 24h
- Added support for returning all data when `range=all` is requested

### Fixed

- Fixed handling of unknown `range` values by falling back to the last 24h instead of returning unscoped data
- Fixed `gjc stats` failing to build the client on globally-installed installs by promoting `tailwindcss` from `devDependencies` to `dependencies` (the client build runs at runtime)

## [14.5.4] - 2026-04-28

### Fixed

- Fixed GPT cost reporting by deriving missing OpenAI code provider costs from the model catalog and backfilling existing zero-cost rows.

## [13.6.0] - 2026-03-03
### Fixed

- Include subtask session files in usage stats ([#250](https://github.com/can1357/gajae-code/issues/250))
