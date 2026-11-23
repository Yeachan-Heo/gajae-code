### Fixed

- Codex Responses requests no longer send the legacy `conversation_id` header; the session identifier goes out only as `session_id`, matching the Codex CLI behavior and ensuring compatibility with proxies that reject underscore header names.
