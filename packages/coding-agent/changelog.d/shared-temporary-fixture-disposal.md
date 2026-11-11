### Fixed
- Dispose temporary-model and DEFAULT-selection test fixtures' owned model registries after their session consumers, preventing background catalog refreshes from leaking into later shared-session tests.
