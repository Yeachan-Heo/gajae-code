### Fixed

- Keep keyboard input and Ctrl+C working after the initial `--resume` session picker on Windows by finishing picker teardown on the next event loop turn before starting the chat TUI.
