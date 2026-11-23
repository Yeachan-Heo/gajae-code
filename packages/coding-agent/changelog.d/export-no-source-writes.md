### Fixed

- `gjc --export` no longer writes to the session it exports. Before this fix, an export could append replay-metadata patch records to the transcript, rewrite an older-version transcript in the current format, build session-memory sidecar files and a build-lock file in the session's artifact directory, and delete a legacy `.jsonl.spill.*` sidecar next to the transcript. Export now loads a read-only in-memory snapshot, and the HTML output is unchanged.
- A transcript larger than the 128 MiB eager-load limit now fails to export with an export-specific "too large to export" error. Before, such a transcript was exported only when it had no session-memory sidecars yet, by building them next to the source.
