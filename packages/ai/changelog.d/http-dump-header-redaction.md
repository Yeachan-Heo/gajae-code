### Fixed

- HTTP 400 request dumps redact `x-goog-api-key` and `cf-aig-authorization` before the dump JSON is written, and the dump file is created owner-readable only.
