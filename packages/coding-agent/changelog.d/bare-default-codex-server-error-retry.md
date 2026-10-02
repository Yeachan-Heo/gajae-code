### Fixed

- Sessions without explicit `retry.*` settings now auto-retry a content-free OpenAI Codex `server_error` / `internal_error` error event, the same way a content-free `server_is_overloaded` event is already retried. Attempts that produced visible output or tool content are still never retried.
