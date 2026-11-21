### Fixed

- Tool argument validation now correctly handles nullable properties: JSON `null` is preserved when the schema accepts it (instead of applying defaults or deleting); the string sentinel `"null"` is always removed for optional fields (meaning "no value"); and local `$ref` references are resolved correctly during null validation (#7916).
- Added regression tests for nullable normalization invariants across schema variants (`anyOf`, `oneOf`, `allOf`, nested objects, and local `$ref` definitions).
