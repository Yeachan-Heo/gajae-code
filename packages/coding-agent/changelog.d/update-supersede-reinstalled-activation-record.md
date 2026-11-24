### Fixed

- `gjc update` no longer stays blocked by a leftover staged or pending activation record after the installed binary was reinstalled or swapped outside gjc, as long as that record never started promotion. Records whose promotion may have reached the binary, and records created when no binary existed yet, still require reconciliation.
