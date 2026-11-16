### Fixed

- OpenAI-compatible completions providers normalize an SDK connection timeout before response headers to the typed first-event timeout for every provider, not only Alibaba Token Plan. A slow relay that timed out before headers produced an untyped error that the managed fallback chain classified as `other`, so the task failed instead of retrying or failing over.
