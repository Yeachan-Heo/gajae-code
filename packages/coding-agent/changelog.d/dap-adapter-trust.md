### Fixed

- Debug adapter lookup uses the same trusted `$PATH` rule as LSP auto-detection, so a repository `bin/`, `node_modules/.bin`, or virtualenv binary is no longer spawned as a debugger.
