### Fixed

- Resuming a session with an unavailable pinned credential no longer aborts when the startup model profile probes that provider; credential failure is reported so the user can re-pin or select AUTO.
- Resuming a session with an unavailable pinned credential now honors an explicit `--api-key` or `models.yml` provider key when restoring the saved model, the settings default, and extension-registered models, following the same key precedence as request authentication instead of reporting the pin unavailable. Without an explicit key, that provider's stored accounts stay blocked.
