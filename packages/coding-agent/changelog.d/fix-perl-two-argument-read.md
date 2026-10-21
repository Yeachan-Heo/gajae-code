### Fixed

- Restore parenthesized two-argument literal read-only Perl `open` calls during planning, including escaped literal backslashes, while rejecting custom `open` suffix calls, unsupported handles, and unsafe or unparsed modes.
