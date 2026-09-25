### Fixed

- Share per-credential provider usage probes across processes through `agent.db`: a cross-process lease single-flights each credential's `/usage` request, a failed probe with no last-good report is now cooled down for about a minute instead of being retried on every credential selection, and loading credentials into a new process no longer purges the reports its peers already cached. Concurrent and back-to-back `gjc` processes no longer each hit the provider's usage endpoint and trip its 429 rate limit ([#5939](https://github.com/Yeachan-Heo/gajae-code/issues/5939)).

### Added

- `AuthStorage.setUsageProbeMode("cache-only")` limits credential ranking and quota checks to usage reports already cached in the shared store, so callers that never display usage can select credentials without calling provider usage endpoints.
