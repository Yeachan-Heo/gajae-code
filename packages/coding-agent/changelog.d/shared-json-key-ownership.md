### Fixed
- Preserve literal `__proto__` JSON keys in shared-publication payloads and session defensive copies instead of interpreting them as prototype changes. This prevents metadata loss without changing publication admission, execution-receipt policy, or production activation.
