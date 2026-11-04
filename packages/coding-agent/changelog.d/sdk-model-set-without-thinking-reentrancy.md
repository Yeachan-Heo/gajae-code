### Fixed

- SDK `model.set` without a `thinkingLevel` no longer fails with `busy` (same-session reentrancy) on a concrete model. The selection admits itself, and the config-override reconciliation runs inside that admission.
