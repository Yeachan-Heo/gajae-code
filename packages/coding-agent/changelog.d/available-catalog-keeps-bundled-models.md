### Changed

- The selectable model catalog is no longer narrowed by live provider discovery. A discovered catalog now only enriches the bundled catalog — it adds newly discovered ids and refreshes metadata — and never deletes a bundled entry a provider omits. A model the provider (or the signed-in plan) does not list stays selectable, and the provider's own typed error surfaces when it cannot be used. For `openai-codex` this ends the plan-scoped hiding that removed bundled ids such as `openai-codex/gpt-6.1-sol` from `/model`, profile activation, and preset availability on lower-tier ChatGPT accounts.

### Removed

- Removed `ModelRegistry.getAvailableForProfileActivation()` and the live-catalog "authoritative ids" filter behind it. Profile activation, preset landing, startup fallback resolution, and model materialization now read `ModelRegistry.getAvailable()` directly.
