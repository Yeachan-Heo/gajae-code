### Added
- Provide opaque endpoint-routing capture and read APIs that preserve trusted URL, Azure resource/deployment/version, Google project/location, and Foundry-mode source policies. A captured absence never falls back to later live configuration.
- Reject reconstructed or serialized handles and non-routing reads without capturing API keys, OAuth tokens, or ADC credentials. Omitted handles retain the existing standalone live-source behavior.
- Capture base URL names using the platform's environment-name rules, preserving Windows case-insensitive routing and POSIX case-sensitive absence.
