### Fixed

- Canonicalize temporary fixture paths in the signed file-lock identity regression suite so Windows path aliases do not bypass the stat mocks and falsely fail dead-owner reclamation checks.
- Preserve the original temporary fixture spelling for root, staging, and detached cleanup so Windows drive-letter, UNC, and short-name aliases remain inside the test harness's allowed root; UNC temp roots without a caseable path component still exercise cleanup using their original spelling.
