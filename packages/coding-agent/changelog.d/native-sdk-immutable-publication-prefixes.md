### Fixed
- Keep SDK resume publication receipts bound to their immutable issued byte prefix across same-inode appends and checked replacements; appended ranges still require independent durability evidence.
- Reject initial publication receipts whose header differs from the fresh transcript reducer header, including after checked replacement.
