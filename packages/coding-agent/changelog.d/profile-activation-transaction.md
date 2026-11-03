### Changed

- Switching the default model profile now runs as one prepared transaction (prepare → commit → finish) fenced on the session's identity generation: an activation superseded mid-flight rolls back only its own writes, so a concurrent identity or profile change no longer inherits a half-applied projection.
