### Fixed

- `monitor` now rejects an explicit `timeout` above 3600 seconds before starting a job, instead of accepting it and silently stopping the monitor after 3600 seconds (#5970).
