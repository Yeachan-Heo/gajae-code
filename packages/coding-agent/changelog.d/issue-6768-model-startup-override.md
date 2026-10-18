### Fixed

- Keep CLI startup model overrides run-scoped: one-shot model selections no longer rewrite the global model profile configuration or model-usage order (fixes #6768).
- Keep a durable default model profile whose activation failed (for example, missing provider credentials), including when its identity was restored from session history: role-only selections save only the selected role and never persist the startup override as `modelRoles.default` (fixes #6768).
