### Added

- `agent_failed` and the terminal assistant message now carry the optional bounded `providerDiagnostic` when the provider adapter classified the failure from its own structured metadata. It is read only from the adapter's private carrier, so a foreign error that self-declares a `providerDiagnostic` property gets none, and the sanitized failure code and fixed message are unchanged.
