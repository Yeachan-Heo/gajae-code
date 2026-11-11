### Fixed
- Release a direct ephemeral turn's IRC roster claim when the call aborts, not when its detached credential or provider work later settles, so an immediate retry redelivers the roster again (regression from #7687).
