
### Fixed

- Reject unsafe paths, malformed operations and unjournaled ancestor replacements before applying atomic batches. Stage memory updates, isolate YAML builder inputs and preconditions, reject nested queue deadlocks, return independently owned inverse receipts, and preserve literal model-role keys across reload.
- Reject nested Settings flushes that would wait on another active YAML owner, preserving deferred writes and independent FIFO operations.
- Prevent queued or asynchronous current-value atomic builders from overtaking newer local setters or runtime override intent, including same-value/ABA writes and setters already captured by an earlier save. Preserve completed lock-only profile deletion and durable receipt ownership; keep synchronous memory publication and ordinary queued batches correctly ordered.
- Re-read the durable file when a newer overlapping atomic batch supersedes a publication, so `Settings` memory is reconciled with `config.yml` instead of keeping the pre-batch value. A failed re-read is logged and reconciled by the next load or refresh, so the caller still learns the durable commit succeeded.
- Publish runtime override changes to subscribers. Every explicit runtime mutation invalidates a prepared builder, including an absent-path clear; an absent-path clear does not publish a value change.
- Fire presentation hooks (`theme`, `symbolPreset`, `colorBlindMode`, `display.tabWidth`) only on the presentation-owning instance: scope-local instances do not mutate terminal presentation globals. Only instances with durable storage persist changes; the presentation owner must reload to observe another instance's durable write.
- Populate `CasReceipt.revisions` for in-memory (`Settings.isolated`) batches as well as durable ones, so an embedder sees the same receipt shape in both modes.
