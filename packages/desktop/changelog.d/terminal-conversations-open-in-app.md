### Changed
- A conversation started in the terminal now opens in the app exactly like one started in the app: the app continues it itself, with Session work, tools, todo, editing, forking, images, Disconnect and Connect all available, instead of a reduced remote view that showed internal errors under the composer and in Session work. While a terminal has the conversation open, the app shows it read-only with "Check again", as it does for its own conversations; it no longer sends prompts into a session a terminal is running.
- Deleting a terminal-started conversation in the app now deletes it, transcript included, as for any other conversation. It was refused before.
- Transcripts kept under a project's own `.gjc` folder, such as a workflow's subagent sessions, are no longer listed as conversations in the app. Resume them from the terminal.

### Fixed
- Opening a terminal-started conversation no longer starts a background SDK broker and a session process that kept running after the app closed. A process an earlier build may have left behind is closed when its conversation is checked, only while it is idle, at most three tries per conversation; a terminal is never closed. While such a process is still busy, the app says so instead of calling it a terminal.
- Conversations an earlier build listed from the terminal keep loading. One whose transcript no longer exists, or is kept in the project's `.gjc` folder, says so in plain words and can be removed from the list.
- A terminal conversation in a workspace under `/tmp` or `/var/folders` on macOS, or one started from a symlinked folder, now opens, copies and deletes in the app instead of failing with "Session project does not match catalog".
- With no SDK broker running, the app still recognises a conversation a terminal has open, including one started with `GJC_SDK_DISABLE=1`, and refuses to delete one it cannot prove is free instead of deleting it.
