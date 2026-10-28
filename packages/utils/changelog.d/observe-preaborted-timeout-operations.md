### Fixed

- Observe failures from already-started operations when a timeout wrapper receives an already-aborted signal, preventing an unrelated unhandled rejection during cancellation.
