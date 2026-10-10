### Performance

- Skip full-transcript resize-width scans on unchanged-width render frames while preserving the existing resize and forced-redraw checks.
- Avoid copying unchanged terminal-control spans, reuse retained row widths, consume only the first grapheme for cursor operations, stop select-list width scans at their bounds, and avoid redundant background-row padding.

### Added

- Added cancellable, one-shot `enqueueBeforeRender` preparation on the existing frame scheduler and a single-owner `setRenderPreparationLifecycleCallbacks` seam for invalidation and restart preparation. Stop, terminal loss, and disposal cancel stale work; restart preparation runs before the first forced frame without adding another streaming timer.
