### Fixed

- The detached SDK broker's discovery budget is now published as a composition (`BROKER_DISCOVERY_BUDGET`) instead of three module-private constants and a restated sum, and every deadline and poll on that path runs on an injectable clock. The spawn single-flight regression that stages stale retirement, child-fence contention, and startup no longer retypes the budget arithmetic, so it keeps an explicit margin rather than resolving on process-startup latency, and a change to any single leg now fails an assertion instead of silently re-tuning the race (#5604).
