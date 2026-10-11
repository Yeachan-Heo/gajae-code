### Fixed
- Managed-session descriptor preflight and bounded range reads now preserve their original metadata, pathname, or range error when descriptor close also fails; close-only errors after a successful read still propagate.
