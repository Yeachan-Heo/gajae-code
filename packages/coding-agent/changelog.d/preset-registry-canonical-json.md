### Fixed

- Validating cached model-preset registry documents is about a third faster: canonical JSON serialization no longer calls `JSON.stringify` for strings that need no escaping and checks surrogates with the native well-formedness test.
