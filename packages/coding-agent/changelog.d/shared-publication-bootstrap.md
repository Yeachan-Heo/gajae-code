### Fixed

- Allow explicit shared-message publication to create a fresh managed transcript under its session transaction, preserving pending metadata and entry IDs without overwriting an existing file. This also publishes user-only sessions through the shared API; ordinary synchronous append behavior remains deferred.
