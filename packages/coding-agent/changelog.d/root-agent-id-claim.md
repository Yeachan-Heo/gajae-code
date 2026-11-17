### Fixed

- A second in-process root session no longer replaces the first session's `0-Main` registry entry, so IRC addressed to that id stays on the session that claimed it. Search, find, and bash resolve `memory://` with the calling session's settings instead of the process agent directory.
- `local://` reads resolve against the calling session's own scratch root. A second live root previously inherited the process-global binding, so one session could read another session's `artifacts/local` or managed `/tmp/gjc-local/<session>` files. Only an explicitly installed binding is still shared.
