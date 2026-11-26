### Fixed

- On Windows, the `bash` tool description now tells the model that the tool runs a bash-compatible shell, not PowerShell or cmd. Models previously wrote `$env:VAR=…`, `Remove-Item`, or `dir /b` on their first attempt, which failed with `command not found` and cost an extra tool round-trip (#8072).
