### Fixed

- Refuse an ast_edit directory root that resolves outside the session, and keep the native search path identical to that checked path so a trailing-space directory is not rewritten through a sibling symlink.
