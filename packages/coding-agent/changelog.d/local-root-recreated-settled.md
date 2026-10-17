### Fixed

- `local://` no longer fails with `Unsafe local:// root` for the rest of a session after the temp sweeper removes the session's scratch directory and another gjc process for the same session recreates it; a recreated root owned by you, private to you, and carrying a settled migration marker is adopted.
