### Fixed

- Status lines strip terminal control sequences, flatten embedded newlines and tabs to spaces, and preserve caller-provided SGR styles and OSC 8 hyperlinks, preventing repository text from injecting terminal escape controls or misaligning cursor layout.
