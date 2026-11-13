### Fixed

- Fixed crash-log identity cache regression where deferred records (future timestamps) would never be recovered. The identity cache now correctly excludes records that are deferred due to future timestamps, allowing recovery to be re-attempted when time advances past the deferral window. Pre-existing indices cached before this fix may retain stale cache entries until natural invalidation (log change) or deployment of future cache versioning; this is a rollout limitation that does not affect new deployments.
