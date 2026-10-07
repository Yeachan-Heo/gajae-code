### Fixes

- Interactive startup now retries a failed default model profile once after reloading auth and refreshing the catalog, covering transient credential/availability issues that resolve within ~7 seconds of startup.
- When a default profile fails to apply after retry, the session now shows a persistent status-line marker (`profile unavailable: <name>`) instead of silently using the fallback model, giving users explicit visibility into the recovery state.
