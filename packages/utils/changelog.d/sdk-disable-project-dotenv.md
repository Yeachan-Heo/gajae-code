### Fixed

- A project `.env` can no longer set `GJC_SDK_DISABLE`. That name is the operator opt-out for SDK hosting, and a repository must not be able to turn hosting off. A shell export is kept unless it matches the project declaration or that declaration is dynamic. An escaped dollar is a literal, and provenance compares Bun's decoded text.
