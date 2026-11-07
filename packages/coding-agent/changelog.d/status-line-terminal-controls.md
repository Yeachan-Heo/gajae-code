### Fixed

- Status lines strip terminal control sequences via a linear-time scanner, flatten embedded newlines and tabs to spaces, and preserve caller-provided SGR styles and well-formed OSC 8 file hyperlinks while stripping arbitrary or unterminated OSC 8 sequences, preventing repository text from injecting terminal escape controls, misaligning cursor layout, or stalling the event loop.
