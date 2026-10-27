### Fixed

- Status lines strip terminal control sequences and flatten embedded newlines from title, description, badge, and meta text while preserving caller-provided SGR styles, preventing repository text from injecting terminal escape controls.
