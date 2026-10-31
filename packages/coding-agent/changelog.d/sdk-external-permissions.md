### Added

- Expose opt-in, session-scoped external tool approvals through `permission.channel.set`, `permission.requests.list`, and `permission.respond` on the public machine SDK/session CLI, with tool input context, rejection comments, bounded waits and fail-closed cancellation. This is the upstream prerequisite for Heyaaz/gajae-bot#165, not its desktop implementation.

### Fixed

- Route delegated task approvals to the parent SDK external permission queue without inheriting terminal or filesystem capabilities; cancel pending descendant approvals when the parent policy or provider changes.
