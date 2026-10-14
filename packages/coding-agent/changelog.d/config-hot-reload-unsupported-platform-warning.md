### Fixed

- Stopped showing "Configuration watching could not start because directory ownership and privacy could not be verified" on every interactive launch on macOS and other non-Linux platforms, where configuration hot reload is unsupported; the warning now appears only when a supported platform finds untrusted configuration directories.
