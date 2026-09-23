### Added

- `anthropic/claude-opus-5-5` is curated as the rank-1 `strong` autorouting tier at `high` effort, demoting `anthropic/claude-opus-5` to rank 2 and `anthropic/claude-opus-4-8` to rank 3; Anthropic reports Opus 5.5 at Fable 5.1-level quality for ~40% less compute per task, so it dominates the model it displaces on both axes. The remaining 341 new catalog keys from the same regeneration are recorded in `TIER_MAP_SKIP_LIST` as uncurated, keeping the tier-map gate authoritative rather than widening it.
