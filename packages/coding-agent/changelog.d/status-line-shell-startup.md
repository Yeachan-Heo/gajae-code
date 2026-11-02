### Fixed

- Status-line commands and finalize validation no longer run repository `.env` shell startup files (`BASH_ENV`, `ENV`, `ZDOTDIR`). A different caller value is still passed to the child.
