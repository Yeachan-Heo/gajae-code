### Fixes

- **Task concurrency** - Fixed unbounded concurrency in `task()` calls that caused VM crashes. The `task.maxConcurrency` setting now enforces a session-global limit across all concurrent detached and nested task calls, using a single pool instead of per-call semaphores. Deadlock prevention: nested tasks (taskDepth > 0) bypass slot acquisition, allowing children to proceed while parents wait. Runtime changes to `task.maxConcurrency` take effect on the next task acquire. (#7995)
