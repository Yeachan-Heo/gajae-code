### Fixed

- A Codex websocket `Invalid previous_response_id` error with a sent anchor and no output now retries with anchor-free resend under managed fallback. Previously the recovery was skipped when `fallbackManaged` was true, leaving the fallback chain to fail the turn. The fix removes the guard, so the single one-attempt recovery runs under all non-disabled retry paths, allowing subsequent fallback entries to continue if resend yields no output (#6185).
