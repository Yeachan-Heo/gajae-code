### Fixed

- Apply sampling settings changes to live embedding and TUI sessions through shared settings observation, including atomic commits and CAS restores. Preserve atomic receipts and other observers when a change listener fails.
- Publish sampling adopted during successful or failed ordinary saves, isolate process-global presentation hooks, and fence overlapping same-value/ABA writes across in-process settings owners without rejecting unrelated model-role changes. Cross-process ownership still uses the existing hash/exact-file checks.
- Reject forged, copied, foreign, discarded, and replayed notification provider drafts; claim Telegram setup drafts before asynchronous work to prevent concurrent commits. Block active writes for foreign or unverifiable daemon identities while retaining inactive saves, require durable settings for notification mutations and external runtime actions, and report post-restore or session-reconciliation failures separately from persistence.

- Reject unsafe paths, invalid operations, overlapping batches, and unjournaled ancestor replacements before mutation. Stage in-memory updates atomically, protect YAML builders and CAS preconditions from mutable inputs, and avoid inherited-property traversal when clearing overrides.
- Return independently owned inverse receipts from memory restores, preserve literal model-role names across reload, and reject intervening writes to asynchronously prepared current-value batches.
- Return failed notification saves to fresh setup instead of retrying consumed drafts. Require portable interaction shutdown before session shutdown and settle only validated request identities.

### Added

- Public portable extension interactions and shared extension initialization, with explicit terminal-only refusals and session/connection/request ownership.
- Lazy session-owned job observation with owner/generation-scoped monitor controls and read-only folded work.
- Shared trusted-local notification setup operations used by the TUI and embedding SDK. These additions do not install new managed operations or establish full SDK/TUI parity.
