### Added

- The Session work toolbar button shows a compact done/total chip whenever the conversation has a task list, so progress stays visible with the card closed; the button's name and tooltip say the same, for example "Session work, 2 of 5 tasks done".
- The task list numbers its phases with their own done/total, draws a thin progress bar, marks tasks that have notes and shows the notes of the task in progress (up to the five newest per task).
- An expanded todo_write row in the conversation shows the resulting task list instead of the tool's raw text once its details are available.
- The Session work card says "Task list may be out of date" when the newest task list update in the conversation failed.

### Changed

- Abandoned tasks now count as finished in task list progress, matching the terminal, and a list at the 120-task limit says that only the first 120 tasks are shown.
