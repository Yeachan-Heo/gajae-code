### Fixed

- SDK broker startup no longer publishes broker discovery while the session-heartbeat checkpoint transaction still holds the session-index lock. The checkpoint now completes its transaction before returning, ensuring the index is available for concurrent reads.
