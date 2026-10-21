### Fixed

- Managed `local://` session roots now live in persistent per-user state instead of temporary storage, so reusable session files survive temporary-directory cleanup and host reboots. Runtime guidance directs reusable files to `local://` or the project tree, and garbage collection continues to reclaim only marker-only roots after the grace period.
