### Fixed

- macOS directory scans use `getattrlistbulk` again: the attribute request lacked `ATTR_CMN_RETURNED_ATTRS`, so the kernel rejected it and every directory fell back to `std::fs::read_dir`.
