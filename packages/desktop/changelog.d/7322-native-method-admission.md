### Fixed

- Preserve shared terminal HOME/configuration roots through host initialization, create the app data directory on first launch, and keep explicit QA isolation stable across both startup stages.
- Delete app-owned transcripts, derived spill files and sibling artifacts through canonical SDK explicit-directory storage cleanup instead of a separate raw recursive-removal path.
- Admit the advertised command catalog/dispatch, history paging and queue-cancellation methods through the native Tauri bridge. Exercise the actual native request encoder against the canonical host method catalog and reject unknown or invalid envelopes without forwarding them.
