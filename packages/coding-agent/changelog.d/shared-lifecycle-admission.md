### Fixed

- Refuse unsupported shared-session relocation, deletion and graph-successor publication before their guarded effects. Deletion checks the target session identity, and prepared graph successors retain source provenance; unrelated fresh sessions, local navigation and resource-only close remain available. Existing POSIX nonempty-artifact cleanup can still report `cleanup_pending` and retain its retired namespace.
