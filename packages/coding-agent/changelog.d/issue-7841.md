### Fixed

- Print mode (gjc -p, especially after --resume) now correctly handles assistant responses when message compaction occurs during the prompt. Previously, compaction could shrink the messages array, making the pre-prompt index stale, which caused resolvePrintTerminalDisposition to fail and report "empty_response" even though the final assistant text was printed. The fix tracks the user message submitted in the turn and uses it to locate assistant messages robustly regardless of compaction. (#7841)
