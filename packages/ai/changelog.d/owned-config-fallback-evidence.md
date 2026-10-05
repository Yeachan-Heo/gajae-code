### Fixed
- Isolate configuration fallback resolvers and evidence generations by their actual owner, copy resolver authority on configuration forks, and prevent stale disposers from removing replacement resolvers.
- Keep stored command-key resolution coalesced across sibling configuration changes while shared credential-row replacement invalidates stale resolution and matching. Credentials, runtime selectors, and OAuth registration/dispatch remain shared.
