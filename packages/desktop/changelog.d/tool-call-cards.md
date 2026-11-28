### Added
- Tool calls in a conversation now say what they acted on: each row shows the kind of call, the file, command, pattern or query it used, small results such as lines added and removed, match counts or an exit code, and the model's stated reason for the call. Finished calls show no status; failed, cancelled and background calls say so.
- Calls that are still running appear in the conversation while it works, with the newest output of a running command, and become the finished row in place when they complete.
- Expanding a tool row loads its full details: the whole command, a colored per-file diff for edits, the content a write produced, and the remaining arguments. Credentials the app knows about are removed before anything is shown.
- Two or more tool calls in a row fold into one collapsed group that counts them, names their kinds and failures, and always shows the newest call. Groups open only when you open them.
