### Fixed

- `gjc --export` no longer writes to the session it exports. Before this fix, an export could append replay-metadata patch records to the transcript, rewrite an older-version transcript in the current format, build session-memory sidecar files and a build-lock file in the session's artifact directory, and delete a legacy `.jsonl.spill.*` sidecar next to the transcript. Export now loads a read-only snapshot that never writes to the transcript, its artifact directory, the managed session store, or the terminal breadcrumb, and the HTML output is unchanged.
- `gjc --export` now exports a legacy v1 transcript that contains a compaction. Before, it failed with `cold_transcript_header_invalid` and could leave partial session-memory sidecar files in the source's artifact directory.
- If the source transcript disappears while `gjc --export` is opening it, export now reports `File not found` instead of creating a new empty session at that path.

### Changed

- `gjc --export` now refuses every transcript larger than 128 MiB with a "too large to export" error. Before, such a transcript, including a default-store session, could be exported once while it had no session-memory sidecars yet, by building sidecars in its artifact directory (in the managed store for default-store sessions); a later export of the same file was already refused.
- `gjc --export` no longer repoints this terminal's `gjc --continue` at the exported session.
