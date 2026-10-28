### Fixed

- Collapsed Google Antigravity `/usage` rows by shared quota pool and preserved account email labels across live and cached usage views (#7267).
- Kept accounts that report only one horizon of a quota pool in the sibling `/usage` row as `not reported` cells (unknown bar, `N% free · M not reported` aggregate, warning instead of a false `exhausted`) instead of dropping the column (#7267).
