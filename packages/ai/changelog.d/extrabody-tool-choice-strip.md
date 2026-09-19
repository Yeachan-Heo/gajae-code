### Fixed

- openai-completions no longer re-injects a `compat.extraBody` `tool_choice` on turns that deliberately carry no tools, preserving the empty-tools strip for strict backends that reject `tool_choice` without a `tools` list.
