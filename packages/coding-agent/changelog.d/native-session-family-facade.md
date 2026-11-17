### Added

- `opened.runtime.session` gives embedders the transcript and view work the session itself owns: revision and branch, command and model refresh, rename, tool selection, thinking level, skill reload, compaction, retry, automatic title and HTML export. Every entry point runs under native admission, so an embedder no longer has to reach into the raw session for these operations.
