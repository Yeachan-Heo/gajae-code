### Fixed

- Release the SQLite OAuth refresh lease when a token refresh fails, so peer processes can retry immediately.
- Give each unshared OAuth refresh attempt a unique lease owner so retries cannot renew or release another live attempt's lease.
