### Fixed

- Mid-run context maintenance no longer ends the turn with `Context maintenance could not commit a compaction before the next model request.` when compaction has nothing to summarize but the unchanged context still fits the model window with its reserve. It sends the request, as the end-of-turn threshold check already does. This was common on 1M-window models when a session started with one very large message (#6813).
