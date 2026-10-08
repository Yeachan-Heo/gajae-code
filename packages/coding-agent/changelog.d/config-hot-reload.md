### Added

- Reload user settings and model configuration in open interactive sessions at safe request boundaries, with validated changes, preserved session overrides, and refreshed model/status displays.

### Fixed

- Preserve successive manual model selections, completed provider discovery, and unchanged credential discovery restrictions during configuration reload. Validate reload credentials without rejecting refreshable OAuth accounts or registering API keys that conflict with a credential pin in any live session.
- Preserve live model, thinking-level, and newer profile-owned selection state across asynchronous reload preparation and rollback after publication failures.
- Re-stage an immutable reload snapshot after a catalog refresh invalidates preflight, and re-arm failed directory watches so ordinary later saves are still observed.
