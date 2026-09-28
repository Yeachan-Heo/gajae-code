### Fixed

- **test: add real behavior verification to mock-only test assertions** — Enhanced acp-builtins.test.ts "model: applies explicit thinking level to the live default session" to verify actual user-visible output after spy calls. This pattern ensures tests exercise real code paths and catch integration issues that would surface in production. Spy assertions alone don't guarantee correct behavior; output verification confirms the user-facing result.
