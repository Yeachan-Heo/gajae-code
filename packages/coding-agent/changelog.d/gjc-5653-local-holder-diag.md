### Fixed

- File-lock acquisition exhaustion now reports the real liveness of a holder running on this host instead of calling every host-qualified record "liveness unknown from this host". A lock owned under this installation's current or previous host identity is probed and described as live, dead but not reaped, or indeterminate; only a genuinely foreign owner stays opaque. Reclamation authority is unchanged — the diagnostic and the stale verdict now share one host predicate so they can never disagree about whose PID a record names (#5653).
