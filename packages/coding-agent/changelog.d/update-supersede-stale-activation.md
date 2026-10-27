### Fixed

- Let `gjc update` supersede a pre-promotion activation record left by a failed attempt at an older release instead of failing every later update with `activation_transaction_requires_reconciliation`. The record is superseded only while the installed binary is still the exact recorded baseline (issue #6096).
