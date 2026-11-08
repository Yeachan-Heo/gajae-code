### Fixed

- Await migration finalization for caller-supplied managed sessions before SDK settings/auth initialization, runtime setup, and context restoration. Refuse stale, unsupported, or unpublished migration outcomes without retrying or disposing caller-supplied managers; preserve fresh-session bootstrap staging and bounded current-format resumes without adding a full-transcript snapshot. Capture manager selection before startup awaits so caller options mutation cannot replace the admitted manager or default ownership.
