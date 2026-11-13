### Fixed

- Windows: fixed TUI corruption (mojibake and line-stacking) after bash-tool commands that change the console code page (e.g., `chcp 1252`). GJC now captures the console's intended UTF-8 code page (65001) at startup and restores it after each bash command completes, even if the child process changed it.
