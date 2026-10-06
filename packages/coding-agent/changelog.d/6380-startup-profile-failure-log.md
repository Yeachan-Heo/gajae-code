### Fixed

- Startup now writes a `logger.warn` record (profile name, error class, providers) when the persisted default model profile is skipped for missing credentials or an unknown profile name, so a session left on the provisional model can be diagnosed from `~/.gjc/logs` after the toast is gone (#6380).
