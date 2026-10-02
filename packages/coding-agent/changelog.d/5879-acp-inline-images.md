### Fixed

- Accept standard ACP inline images larger than the private SDK frame limit without changing image bytes or requiring Paseo-side uploads.
- Keep delayed-echo successor admission cancellable and restage one-shot image references only after a confirmed busy rejection.
- Remove implicitly diverted queued images before acknowledging cancellation, and finalize each accepted image prompt at its exact consuming-run terminal or confirmed queue removal.
- Bound retained upload allocations for tiny image fragments as well as payload bytes.
