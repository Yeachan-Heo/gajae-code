### Fixed

- File-lock reclaim and release now tolerate filesystems that do not provide a creation time while retaining stable file identity and content checks for safe cleanup (#5549).
