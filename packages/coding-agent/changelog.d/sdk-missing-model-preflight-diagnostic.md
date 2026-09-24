### Fixed

- Answer an SDK `turn.prompt`/`turn.abort_and_prompt` submitted to a session with no selected model with the typed `model_not_selected` control error and a fixed public message, instead of a generic `internal` failure. The local onboarding guidance (providers, commands, environment variables, setup paths) stays local-only and is not published on the control protocol, missing credentials and arbitrary exceptions keep their existing generic classification, and the rejection still happens before admission so no turn is accepted.
