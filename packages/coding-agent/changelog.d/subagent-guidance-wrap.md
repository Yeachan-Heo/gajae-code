### Fixed

- Subagent receipt guidance, such as the await-timeout instruction to inspect progress before cancelling, now wraps to the terminal width instead of being cut to one 80-column preview line. At 60 or 80 columns the instruction used to end mid-sentence before `Inspect progress` or `never cancel`.
