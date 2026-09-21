### Fixed

- An SDK prompt whose `sdk.promptDeadlineMs` lookup misses — no settings object, an unwritten key, or a non-finite stored value — is now bounded by the declared one-hour default instead of a hardcoded 30 minutes, so a long prompt is no longer terminalized at half the timeout the published schema promises.
- The schema entries and the SDK bus and host lease fallbacks now read the same `sdk.promptDeadlineMs` / `sdk.promptMaxRuntimeMs` default constants, so the armed deadline cannot drift from the documented default again (#5583).
