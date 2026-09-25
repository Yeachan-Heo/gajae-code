### Fixed

- Generate the automatic session title when the first user message is typed while the agent is busy (for example during a `/skill:` turn) or is passed on the command line (`gjc "..."`). Previously only an idle editor submission produced a title, so these sessions kept the working-directory fallback name permanently.
