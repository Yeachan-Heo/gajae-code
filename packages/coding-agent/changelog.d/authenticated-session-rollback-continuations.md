### Fixed
- Authenticate session rollback snapshots against private issuer-held state before restoring a persistent session, cold transcript, or externally adopted artifact manager. Cloned, edited, or foreign snapshot objects cannot redirect restoration.
- Preserve persistence failure evidence across rejected adoption and rollback; clear it only after successful fresh authenticated recovery, while retaining legitimate hot and cold rollback behavior.
- Fence artifact allocation and publication against session changes, adopted-manager replacement, rollback, and closing after the final asynchronous allocation. Rejected continuations do not publish content or close caller-owned artifact managers.
- Keep this generic lifecycle repair independent of task-owner locator production and mandatory durable owner publication.
