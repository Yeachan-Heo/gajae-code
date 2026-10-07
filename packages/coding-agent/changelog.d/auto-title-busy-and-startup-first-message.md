### Fixed

- Generate the automatic session title when the first user message is typed while the agent is busy (for example during a `/skill:` turn) or is passed on the command line (`gjc "..."`). Previously only an idle editor submission produced a title, so these sessions kept the working-directory fallback name permanently.
- Title a first message queued during compaction or a foreground Bash/Eval command, and never send a locally handled extension, custom, or MCP slash command (including its arguments) to the title model.
