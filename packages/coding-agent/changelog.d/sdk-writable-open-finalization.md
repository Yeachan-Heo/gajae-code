### Fixed

- Await migration finalization for caller-supplied managed sessions before SDK settings/auth initialization, runtime setup, and context restoration. Refuse stale, unsupported, or unpublished migration outcomes without retrying or disposing caller-supplied managers; preserve fresh-session bootstrap staging.
