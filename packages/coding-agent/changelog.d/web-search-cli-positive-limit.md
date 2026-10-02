### Fixed

- `gjc web-search --limit` now rejects `0` and negative values with an error instead of passing them to providers, where a negative limit silently dropped results from the end of the source list.
