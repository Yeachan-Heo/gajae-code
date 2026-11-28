### Added

- Added `confinedOpenRead`, `confinedWriteFileAtomic`, `confinedUnlink`, and `confinedMkdirAll`, which access a path beneath a root through an `openat(..., O_NOFOLLOW)` walk so a symlink below the root fails the operation instead of redirecting it. Each helper takes the root's pinned `"<dev>:<ino>"` identity and rejects an opened root that no longer matches it. Unix only; other platforms throw `confine:unsupported`.
