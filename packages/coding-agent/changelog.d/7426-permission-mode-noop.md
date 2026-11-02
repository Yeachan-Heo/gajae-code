### Fixed

- Preserve pending SDK and ACP tool approvals when permission mode updates are invalid or unchanged; actual policy transitions still cancel pending approvals (#7426).
- Fence delegated permission providers by the parent policy epoch and cancel stale approvals after policy, permission-provider, abort, or disposal changes without cancelling approvals for filesystem-only bridge updates.
- Inherit the current parent SDK permission provider in task descendants without forwarding unrelated bridge capabilities; revoke cached grants and pending approvals across descendants when inherited authority expires.
