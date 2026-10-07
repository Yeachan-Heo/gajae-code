### Changed

- Raster lease invalidation now returns `"failed"` status instead of `"stale-token"` when a lease has become stale or revoked. This clarifies the failure classification and improves consistency with other operation failures.
- Terminal loss handling for raster operations now skips abort barriers to prevent redundant cleanup sequences during terminal loss recovery.

### Fixed

- Render commits queued behind held raster operations are now properly fenced and deferred until raster operations complete or the TUI is disposed.
