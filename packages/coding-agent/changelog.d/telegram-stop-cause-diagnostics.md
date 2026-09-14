### Fixed

- Preserve bounded Telegram daemon stop causes in ownership records and surface them in status diagnostics. A missing ownership lock no longer implies that a dead daemon exited cleanly; records without a captured cause are reported as unknown.
