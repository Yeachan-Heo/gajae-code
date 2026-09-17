### Fixed

- Runtime skill discovery no longer truncates silently. When more skills match than the effective limit, the result now carries a diagnostic naming both the shown and the matched count plus the two ways to see the rest, so a registered skill beyond the page is explained instead of invisible. The notice is exempt from the bounded diagnostic budget that stale `skills.customDirectories` entries fill, which is exactly the case that hid it (#5536).
- `gjc skills discover` now defaults to the widest page the library serves (50) instead of the agent-sized 20, so a human paging the catalog does not lose entries. The `skill_discovery` tool default is unchanged.

### Added

- `gjc skills discover --limit` and `--query` forward to the discovery library, which clamps `--limit` to 1-50. `--json` additionally emits `scanned`, the deduped policy-allowed skill count the query filter ran against.
