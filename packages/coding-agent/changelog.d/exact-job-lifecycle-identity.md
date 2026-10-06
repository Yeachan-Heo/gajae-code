### Fixed
- Keep asynchronous job lifecycle hooks, settlement bookkeeping, eviction timers, and monitor tombstone cleanup bound to their original jobs so late cleanup cannot evict or purge a replacement using the same ID.
