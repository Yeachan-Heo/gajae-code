### Fixed

- Preserve pending SDK and ACP tool approvals when permission mode updates are invalid or unchanged; actual policy transitions still cancel pending approvals (#7426).
- Fence delegated permission providers by the parent policy epoch and cancel stale approvals after policy, provider, bridge, abort, or disposal changes.
- Add the bounded session-owned approval queue used by the follow-up external polling integration; public polling operations are not exposed by this foundation change.
