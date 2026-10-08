### Fixed

- Repeated identical goal timeouts now trigger a bounded observation window that remains active through the ordinary interactive input wait, wait while delegated tasks remain active, then allow one automatic retry before requesting human attention if the same failure persists.
