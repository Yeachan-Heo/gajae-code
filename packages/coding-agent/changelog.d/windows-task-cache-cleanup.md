### Fixed

- Fixed Windows CI task cache key test cleanup failures (EBUSY/EPERM) by adding exponential backoff retry logic to temporary directory removal. File handles on Windows may remain open during deletion, causing removal to fail; retrying with increasing delays resolves the locking issue.
