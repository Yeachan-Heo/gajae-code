### Changed
- A conversation started in the terminal now opens in the app exactly like one started in the app: the app continues it itself, with Session work, tools, todo, editing, forking, images, Disconnect and Connect all available, instead of a reduced remote view that showed internal errors under the composer and in Session work. While a terminal has the conversation open, the app shows it read-only with "Check again", as it does for its own conversations; it no longer sends prompts into a session a terminal is running.
- Deleting a terminal-started conversation in the app now deletes it, transcript included, as for any other conversation. It was refused before.
- Transcripts kept under a project's own `.gjc` folder, such as a workflow's subagent sessions, are no longer listed as conversations in the app. Resume them from the terminal.

### Fixed
- Opening a terminal-started conversation no longer starts a background SDK broker and a session process that kept running after the app closed. A process an earlier build left behind is closed the next time its conversation is checked, only while it is idle, and a terminal is never closed.
- Conversations an earlier build listed from the terminal keep loading. One whose transcript no longer exists says so in plain words and can be removed.
