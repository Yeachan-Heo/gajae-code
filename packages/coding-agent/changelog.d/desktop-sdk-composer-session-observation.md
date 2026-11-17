### Added

- Add SDK-owned local/shared managed embedding creation/reopening, private control-only sessions, transcript inventory/fork/verified delete, extension UI initialization and joined process/resource cleanup so external applications do not construct coding-agent internals.
- Bind local prompt edits and exact answered-revision selection to the canonical SDK revision service, preserving preflight acceptance journals and actual-run attribution without caller-supplied session/run capabilities.

### Fixed

- Redact known stored credentials before HUD metadata truncation, including overlapping credentials reconstructed by control normalization; withhold transformed fields containing raw credentials when display normalization could consume part of a literal. Keep read-only observations available during MCP control admission without relaxing mutation or identity-transition fences.
