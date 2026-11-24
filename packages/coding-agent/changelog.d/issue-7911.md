### Fixed

- Codex image generation requests no longer send the legacy `conversation_id` header; the session identifier goes out only as `session_id`, matching the Codex CLI behavior.
