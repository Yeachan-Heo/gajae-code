### Added
- Add execution-local custom API callback registries for both `stream` and `streamSimple`. Explicit scopes never fall back to process-wide registrations, and snapshots retain their own callback mappings.

### Fixed
- Reject disposed or serialized registry capabilities before provider dispatch, and reject custom registrations that collide with built-in API names, including Kiro.
