### Fixed

- ACP `session/new` now waits for the model to settle before building the response when `modelRoles.default` is configured but no `--model` is passed. This ensures the `model` config option is always present in the response, preventing ACP clients (like Paseo) from failing with `model_not_selected` on the first prompt when the session uses a configured default model.
