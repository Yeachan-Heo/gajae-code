### Added

- Added `ultrafast` as a valid service tier value in user settings (`serviceTier` enum)
- Added `ultrafast` to SDK protocol validation for service tier operations

### Changed

- Settings schema now recognizes and validates `ultrafast` alongside existing tiers (auto, default, flex, scale, priority, openai-only, claude-only)
- SDK adapter validation now accepts `ultrafast` in `service_tier.set` operations

### Notes

The ultrafast tier works like flex/scale/priority — it's a cost and processing priority tier, not an Anthropic fast-mode tier. Fast-mode predicates (`isFastModeEnabled`, `isFastForProvider`) correctly exclude ultrafast, maintaining the semantic distinction that ultrafast is a pure cost/priority layer.

Users can configure ultrafast via:
- Settings: `serviceTier: "ultrafast"`
- SDK: `service_tier.set` with tier value `"ultrafast"`
- Command line: future `/fast ultrafast` or UI tier selector additions
