### Added

- `currentEmbeddedInteraction(handle)` exposes the registered `ExtensionInteractionService` a native runtime presents questions through, so an embedder that renders its own dialogs can answer and cancel those requests instead of being refused a foreign UI context.
- `NativeRuntimeRefusal` is exported from the SDK barrel, so callers can distinguish an admission refusal from an ordinary SDK error.
