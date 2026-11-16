### Fixed
- Refuse a deferred TTSR retry if its session entered shared mode after interruption, before changing live history or inserting a reminder. Settle the interrupted turn with a visible warning instead of leaving recovery pending; ordinary retries retain their existing behavior.
