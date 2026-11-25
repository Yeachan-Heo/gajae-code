### Fixed

- Settings migrations now properly tolerate non-object values in legacy settings sections instead of throwing. When a project settings file contains a non-object value where a migration expects an object (e.g., `retry: "off"` instead of `retry: { ... }`), the malformed section is now skipped gracefully and other valid keys are preserved. (#8034)
- Settings layer loading failures are now logged with a warning instead of being silently swallowed, improving visibility into why project settings might be dropped. (#8034)
