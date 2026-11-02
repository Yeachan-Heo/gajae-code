### Added

- Add a schema-derived, read-only SDK settings catalog with layer provenance, explicit withheld values, runtime-choice gaps and unclassified application behavior. Free-form strings and compound values never enter its display snapshot; full settings UI parity remains incomplete.
- Expose canonical smart-routing preview/apply/refresh/clear/enable intents shared with the TUI, with instance-bound preview ownership, stale-source refusal, global-only refresh and explicit durability/activation outcomes.

### Fixed

- Refuse active Telegram configuration for foreign or unverifiable daemon identities, require durable settings for notification mutations and external runtime actions, preserve inactive saves with session reconciliation, and report completed persistence separately from rollback or runtime failures. Protect secret-safe owner metadata and diagnostics.
- Reject unsafe paths, malformed operations and unjournaled ancestor replacements before applying atomic batches. Stage memory updates, isolate YAML builder inputs and preconditions, reject nested queue deadlocks, return independently owned inverse receipts, and preserve literal model-role keys across reload.
- Enforce portable interaction payload limits on detached data and fence reentrant request options before admitting pending interactions.
- Reject nested Settings flushes that would wait on another active YAML owner, preserving deferred writes and independent FIFO operations.
- Refuse modified or raced smart-routing previews instead of silently applying unseen generated routes. Keep preview authority inside the host while returning detached display snapshots.
- Forward the actual committed preview through the controller, model selector and panel instead of regenerating unpublished routes after a catalog change or reporting post-save preview failures as failed commits.
- Preserve newer routing writers during post-save notification failure by restoring only through the atomic receipt's CAS ownership check. Mark open panels unknown after shared invalidation or a failed post-commit UI refresh.
- Bind hand-edit confirmation to the exact guarded state and caller-owned refresh proof, with explicit cancellation; reject intervening edits or catalog drift instead of replacing them unseen.
- Keep routing drafts editable when preview regeneration fails, refuse invalid apply proofs, and distinguish pending or committed global refresh results from effective overlays.
- Prevent queued or asynchronous current-value atomic builders from overtaking newer local setters or runtime override intent, including same-value/ABA writes and setters already captured by an earlier save. Preserve completed lock-only profile deletion and durable receipt ownership; keep synchronous memory publication and ordinary queued batches correctly ordered.
- Derive catalog provenance through canonical cumulative merges, including scalar/null/array ancestor replacement, and retain real keyboard access to fresh routing review after a failed apply.
