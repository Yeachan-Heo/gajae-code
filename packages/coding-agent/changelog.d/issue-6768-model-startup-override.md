### Fixed

- Keep CLI startup model overrides run-scoped: one-shot model selections no longer rewrite the global model profile configuration or model-usage order (fixes #6768).
- Keep a durable default model profile whose activation failed (for example, missing provider credentials) when a later non-default role is selected: only the selected role is saved, and the profile's raw default is no longer written into `modelRoles.default` (fixes #6768).
