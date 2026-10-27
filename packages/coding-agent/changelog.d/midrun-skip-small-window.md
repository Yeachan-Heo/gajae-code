### Fixed

- Mid-run context maintenance no longer ends the turn with `Context maintenance could not commit a compaction before the next model request.` on models whose window is below 300k (for example a 272k window) when compaction has nothing to summarize but the unchanged context still fits the window. The fit check now uses the configured reserve instead of the window-scaled reserve, which below the 300k ceiling equalled the threshold margin and made the #6813 fallback unreachable.
