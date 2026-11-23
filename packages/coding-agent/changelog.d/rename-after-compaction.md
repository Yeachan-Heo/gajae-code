### Fixed

- `/rename` command now works after session compaction by falling back to persisted sessionManager entries when live context contains only compactionSummary placeholders.
- The title input builder now tries multiple sources: live user messages, persisted session entries, and finally summary text from compaction/branch summaries.
- Duplicated title input logic consolidated into a single helper function used by both command-controller and builtin slash-commands.
