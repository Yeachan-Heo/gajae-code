### Fixed

- Portable Unix reads reopen the retained-root entry after reading and require it to name the original descriptor identity; Windows exclusive-write identity failures remove the newly created entry or report cleanup failure.
- Added a narrow `PortableRecoveryFsRoot` authority for root-identity inspection, bounded directory enumeration, single-component no-follow reads, and durable exclusive/atomic-replacement writes. Unix uses a retained directory descriptor; Windows retains no-delete-share handles for the root and its full ancestor chain so neither the lifecycle root nor a containing directory can be renamed or replaced during evidence recovery or publication.
- Portable retained-root reads report `not_found` only for an absent directory entry; symlinks, permission failures, and other `openat` errors remain untrusted evidence.
- Portable atomic replacement retains the staged file handle through rename, then requires the installed device/inode and bytes to match that exact staged object before reporting publication success.
- Native addon validation now rejects same-version retained artifacts that lack `openPortableRecoveryFsRoot` or any retained-root identity, enumeration, read, close, or publication method, allowing normal fallback/reinstall diagnostics instead of a runtime undefined-function failure.
