### Fixed
- Inspect every imported Python `os.system` alias during planning, including repeated and continued import lists, so an unused alias cannot hide a later shell invocation. Keep inert comments and strings read-only while failing closed on unresolved alias calls.
