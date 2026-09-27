### Fixed

- Loading `search` or `eval` for the first time no longer changes its advertised tool description, so the provider-visible `tools` block and the prompt-cache prefix stay stable. Before the implementation loads, the description is now rendered from the session (hashline or line-number display for `search`, the allowed Python/JavaScript backends for `eval`), instead of taking the stub-session text from the generated catalog.
