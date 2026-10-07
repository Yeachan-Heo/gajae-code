### Added

- Reload user settings and model configuration in open interactive sessions at safe request boundaries, with validated changes, preserved session overrides, and refreshed model/status displays.

### Fixed

- Preserve successive manual model selections, completed provider discovery, and unchanged credential discovery restrictions during configuration reload. Validate reload credentials without rejecting refreshable OAuth accounts or registering API keys that conflict with a credential pin in any live session.
