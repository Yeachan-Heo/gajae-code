### Fixed

- Preserve bounded terminal errors when Codex Responses times out mid-tool-call by dropping unvalidated partial arguments, retaining the call identity, and reporting `request_timeout`.
