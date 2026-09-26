### Added

- `agent_failed` and the terminal assistant message now carry the optional bounded `providerDiagnostic` when the provider adapter classified the failure from its own structured metadata. Thrown errors are read only through the adapter's private carrier; terminal assistant messages carry the validated DTO. A foreign thrown error that self-declares a `providerDiagnostic` property gets none. The sanitized failure code and fixed message are unchanged.
