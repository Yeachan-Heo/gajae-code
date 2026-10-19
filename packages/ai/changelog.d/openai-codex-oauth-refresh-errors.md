### Fixed
- OpenAI Codex token refresh error messages now display readable error details instead of `[object Object]` when the OpenAI token endpoint returns structured error objects with `code`, `type`, and `message` fields. Both string errors (with optional `error_description`) and object errors are now handled correctly.
