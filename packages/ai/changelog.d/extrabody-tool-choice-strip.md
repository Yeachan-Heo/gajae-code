### Fixed

- openai-completions treats a `compat.extraBody` `tool_choice` as an endpoint default instead of an override: it fills the gap only on ordinary turns that offer tools and resolved no directive of their own, leaving forced-tool directives and deliberate no-tools turns untouched (strict backends reject `tool_choice` with an empty `tools` list).
