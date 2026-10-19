### Fixed

- Home credential files are no longer loaded when the working directory is that home through another path spelling. A lexical path match still skips them, and the same directory reached by a symlink, macOS `/tmp`, or a bind mount is skipped too. A different directory still supplies the home dotenv and shell startup files.
