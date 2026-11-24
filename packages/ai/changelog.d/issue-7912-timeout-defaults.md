### Changed

- Raised stream idle and first-event timeout defaults from 120s/100s to 900s. This gives long-running reasoning chains, model startups, and input processing more time before aborting with a stream timeout. Provider-specific overrides (Anthropic: 600s idle, Alibaba: 600s first-event, Ollama Cloud/LM Studio: 300s first-event, etc.) still take precedence over the new defaults (#7912).
