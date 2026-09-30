### Fixed

- `MacAppearanceObserver.stop()` no longer hangs forever when called right after `start()`: a stop that arrived before the observer thread entered its run loop was lost.
- `detectMacOSAppearance()` is no longer wrapped in a work-profile region, whose bookkeeping added ~7% to the sub-microsecond query.
