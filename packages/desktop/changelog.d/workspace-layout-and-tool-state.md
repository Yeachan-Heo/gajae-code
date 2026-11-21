### Added
- Close a workspace from its right-click menu, or from the keyboard (ContextMenu / Shift+F10). Closing hides the workspace and its conversations without deleting the directory or any session, and it stops a turn that is still running; opening the same folder again restores the same workspace and conversations.
- Reorder workspaces and conversations by dragging them, or with the same menu's move items. The order is stored by the host, so it survives a restart, and the insertion line shows the edge the item will land on.
- Show the builtin `todo_write` list above the composer as a collapsed progress line that expands into the reported phases and tasks.
- Show the `goal` tool's objective and status with only the actions that state allows, instead of reading raw goal output.

### Changed
- Each workspace lists five conversations, with a `Show more` button that appends up to five at a time; a search still shows every match, and the conversation you are reading is always listed. A workspace that is being closed leaves the list immediately, and reopening the same folder restores it once the close has finished.
