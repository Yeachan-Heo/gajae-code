### Added
- `AuthStorage.forkConfigOwner()` captures independently scoped configuration keys while retaining shared credential storage, runtime keys, OAuth rotation, and session selectors. Scoped reset and final release do not replace parent or unowned configuration authority.
