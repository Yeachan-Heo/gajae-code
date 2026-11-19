### Fixed

- The Keenable `web_search` provider now treats a response whose `results` rows are all unusable (null rows or rows without a URL) as a provider failure, so the fallback chain runs instead of returning an empty answer. `results: []` is still a no-hit answer.
