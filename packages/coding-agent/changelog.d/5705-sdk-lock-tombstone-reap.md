### Fixed

- SDK broker startup now reaps aged, empty lock tombstones whose owner record is gone, while retaining non-empty or otherwise ambiguous tombstones and aggregating retention warnings to keep recovery logs actionable (#5705).
