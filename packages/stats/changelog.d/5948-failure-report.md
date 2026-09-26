### Added

- Dashboard stats now include a `failures` report: the error+abort share of requests, time spent in failed requests, and the prompt tokens re-paid by requests that missed the cache entirely right after a failure in the same session. `gjc stats --summary` and `gjc-stats --sync` print it under "Provider Failures", so provider-failure cost can be compared across time windows (#5948).
