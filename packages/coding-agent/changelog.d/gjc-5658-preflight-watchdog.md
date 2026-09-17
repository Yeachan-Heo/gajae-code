### Fixed

- ACP prompts no longer hang forever in provider preflight. The inactivity watchdog is now armed from the moment the prompt owns the session, so a `session/prompt` blocked in `ensureProviders()` is rejected as `prompt_abandoned` — naming provider preflight as the phase — instead of reporting `running` with no output, no tool calls and no error.
- SDK provider activation no longer retries without limit. The registration loop now has an attempt cap and a wall-clock budget, and exhaustion throws `provider_activation_exhausted` naming the contended capability, so lease contention between concurrent session hosts fails attributably instead of spinning.
