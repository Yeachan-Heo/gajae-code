### Fixed

- Bundled Codex `gpt-image-*` models now post to `/codex/images/generations` instead of the Responses route when they target the bundled Codex endpoint. Custom Codex models, including ones that reuse a `gpt-image-*` id behind a custom base URL, stay on `/codex/responses` with the hosted image tool and edits. Codex route normalization works on the base URL pathname, so a trailing `/codex` or `/codex/responses` path is stripped once, query strings are preserved, and fragments are dropped.
