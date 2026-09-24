### Fixed

- Interactive sessions now expose their own async-job snapshot to extensions and the SDK, so `runtime.jobs.list` reports the session's running jobs, recent jobs, and pending delivery instead of failing with `resource_gone`.
- `gjc sdk session` failures caused by a typed `resource_gone` now carry a fixed diagnostic that distinguishes absent resource state from an empty result, without changing the public error code, retryability, or exit code.
