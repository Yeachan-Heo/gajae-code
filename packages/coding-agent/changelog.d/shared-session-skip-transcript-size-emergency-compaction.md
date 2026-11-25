### Fixed

- Fixed shared root TUI sessions running an emergency compaction before every prompt once their transcript passed 48 MiB. Shared compaction only appends a summary and never rewrites the transcript, so this floor could not shrink the file there: each prompt paid for an extra summary call and added a compaction entry (about 190 KB on average in the reported session), which brought the session to the 128 MiB managed limit sooner (#8006). Shared sessions now ignore the transcript-size floor; the other emergency floors and the floor for non-shared sessions are unchanged.
