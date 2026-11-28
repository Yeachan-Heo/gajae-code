### Fixed

- Agent requests using `authHeader: true` now isolate generated Authorization headers from concurrent credential lookups, keeping the dispatched key and stored-credential attribution consistent. Authentication retries refresh the request-local header for the replacement credential.
