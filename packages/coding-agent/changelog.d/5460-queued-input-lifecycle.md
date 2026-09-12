### Added

- The in-process SDK now exposes `session.submitUserMessage()` for tracked queued steers and follow-ups. Each submission has a unique identity plus admission, execution, terminal, cancellation, removal, same-run, successor-run, and sequential FIFO lifecycle receipts without relying on private SDK-host correlation hooks.

### Fixed

- Tracked queued SDK submissions now cancel steers rearmed as follow-ups, retain terminal ownership across per-turn attempt-scope rotation, and reject malformed `submitUserMessage` options before dispatch (#5460).
- Tracked queued submissions settle as removed when successor startup fails before run acceptance, and overloaded AgentSession seams are coalesced in the generated SDK inventory.
- Accepted tracked submissions now settle as removed when session disposal or identity replacement disconnects the Agent event bridge, while invalid queue policies and legacy `sendUserMessage` tracking flags fail before dispatch.
- Forked sessions now drop predecessor queued SDK work and its ownership before publishing the successor identity, including submissions already consumed by the predecessor run.
- Manual compaction now terminalizes already-consumed tracked submissions before disconnecting Agent events while preserving still-queued inputs for post-compaction delivery.
