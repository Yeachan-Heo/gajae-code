### Fixed

- Resuming a session with an unavailable pinned credential no longer aborts when the startup model profile probes that provider; credential failure is reported so the user can re-pin or select AUTO.
- Resuming a session with an unavailable pinned credential now honors an explicit `--api-key` or a literal `models.yml` `apiKey` when restoring the saved model, the settings default, and extension-registered models, instead of reporting the pin unavailable. An `apiKeyEnv` key does not unblock the pin, because another stored api_key account could take precedence over it; without an explicit key the provider stays blocked until the user re-pins or selects AUTO.
