### Added

- `AssistantMessage.promptPrefix` (`PromptPrefixTelemetry`) carries the prompt-prefix fingerprint of the request that produced the message, so prompt-cache misses can be attributed to client prefix mutation or provider eviction (#5946).
