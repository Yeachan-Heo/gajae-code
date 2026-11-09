### Changed

- Thinking-cycle controls now return a promise and await committed session-local publication before reporting success. TUI, extension, SDK, and notification consumers await the result; shared TUI activation remains opt-in.
