### Fixed

- Gate the statusless typed overload check on `managedOutcome` in `#handleRetryableError` to prevent hanging when a managed fallback chain encounters a transport 503 error followed by a typed Responses overload error. The fix ensures that on the agent_end path, the statusless overload check returns false to allow proper session termination handling instead of deadlocking. Fixes #6180.
