### Fixed

- Repeated identical goal timeouts now trigger a bounded observation window, wait while delegated tasks remain active, then allow one automatic retry before requesting human attention if the same failure persists.
