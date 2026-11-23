### Fixed

- Session resume listing no longer re-computes content digests for unchanged managed files. A process-local LRU cache (4096 entries, keyed by device, inode, size, mtime, and ctime) memoizes file hashes during listing operations, eliminating redundant sha256 computation on repeated inspections of the same session inventory. File rewrites are detected reliably via ctime changes, which occur on any write operation (even when mtime is restored via utimes) (#7978).
