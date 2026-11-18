### Fixed

- A run aborted by a canonical publication rejection now logs its underlying cause under a distinct aborted-run diagnostic instead of being reported as a run failure or suppressed as a caller cancellation; the session layer logs the failing operation and its unwrapped cause before aborting, and a deliberate cancellation logs neither entry (#7815).
