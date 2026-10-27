### Fixed

- A project `.env` can no longer set `PI_COMPILED`. That name is a build-only marker for standalone binaries, and a repository must not be able to make a source process look compiled. A value exported by the launching shell is kept unless it is the same string the project declares.
