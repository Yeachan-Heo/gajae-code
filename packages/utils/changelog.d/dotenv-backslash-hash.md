### Fixed

- A project `.env` can no longer hide a harness-directory assignment behind an unquoted backslash before `#`. The provenance check now reads the same value Bun loads, and a different shell value is still kept.
