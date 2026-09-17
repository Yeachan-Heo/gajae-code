### Fixed

- Runtime skill discovery no longer truncates silently. When more skills match than fit on one page, the result now carries a diagnostic naming the shown range, the total matching count, and the exact `--offset` to continue from, so a registered skill beyond the page is reachable instead of invisible. The notice is exempt from the bounded diagnostic budget that stale `skills.customDirectories` entries fill, which is exactly the case that hid it (#5536).
- `gjc skills discover` now defaults to the widest page the library serves (50) instead of the agent-sized 20, so a human paging the catalog does not lose entries. The `skill_discovery` tool default is unchanged.

### Added

- `gjc skills discover --limit`, `--query`, and `--offset` forward to the discovery library, which clamps `--limit` to 1-50 and treats `--offset` as a zero-based index into the matching set. Paging is stateless: the text output prints a runnable next-page command (echoing the filters you passed) and prints nothing on the final page. `--json` additionally emits `matching` (skills left after the query filter), `offset`, `nextOffset` (omitted on the final page), and `scanned`, the deduped policy-allowed skill count the query filter ran against. The page bounds what is returned, not what is scanned: discovery still reads the whole catalog to build the matching set.
