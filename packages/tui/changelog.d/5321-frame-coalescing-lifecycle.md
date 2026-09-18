### Fixed
- Multipart raster output now releases its prefix-barrier ownership when the final terminal write is rejected, terminal availability is lost, or either asynchronous prefix boundary resumes into a stale lifecycle, preventing stale synchronization ownership from surviving terminal loss.
- Coalesced forced redraw generations now remain pending until their shared terminal write commits instead of being failed by a later next-tick callback after frame preparation.
- Disposal and terminal-loss recovery now fence render and raster work already queued behind raster ingress, preventing stale terminal bytes or a falsely successful render generation after the owning TUI lifecycle ends.
