### Fixed

- `SessionManager.moveTo` rewrites the header cwd and recreates the transcript at the new location again; #7858 had dropped that rewrite. Only the move's own relocation rewrite is admitted while the manager owns the cwd transition (#7860).
