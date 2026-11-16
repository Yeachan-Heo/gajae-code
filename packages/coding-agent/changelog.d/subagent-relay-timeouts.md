### Fixed

- The subagent panel names why a subagent left its requested model. A managed chain switch after a rate limit or server failure was labelled `fell back — no credentials`; the label now carries the fallback trigger (`fell back — rate limit`), and `no credentials` is shown only for an actual auth fallback.
- A task receipt whose retries stopped names the typed class of the last provider failure (`retry stopped after attempt 1 (rate_limit).`), without the provider's error text.
