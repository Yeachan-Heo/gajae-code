### Fixed

- Status-line commands and finalize validation no longer run a repository `.env` shell startup file (`BASH_ENV`, `ENV`, `ZDOTDIR`) when that static value matches the recorded declaration, or when the declaration is dynamic. A different static caller value is still passed to the child.
