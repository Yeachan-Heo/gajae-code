### Fixed

- The stats dashboard API answers `400 Bad Request` for a malformed `?limit=` on `/api/stats/recent` and `/api/stats/errors`, and for a malformed `/api/request/:id`. Before, `limit=abc` failed with a 500 SQLite `datatype mismatch`, a negative limit returned every stored request because SQLite treats a negative `LIMIT` as unlimited, and an id such as `1abc` was read as `1`.
