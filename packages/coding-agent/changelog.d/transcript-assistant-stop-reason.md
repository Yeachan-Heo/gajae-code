### Fixed

- SDK and extension transcript entries now expose the canonical assistant `stopReason` when present, allowing consumers to distinguish successful completion from truncation, tool use, cancellation, and errors. Missing assistant reasons remain unknown, and non-assistant entries omit the field; transcript IDs, full bodies, and content projection are unchanged.
