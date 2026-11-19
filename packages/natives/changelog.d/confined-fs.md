### Added

- Added `confinedOpenRead`, `confinedWriteFileAtomic`, `confinedUnlink`, and `confinedMkdirAll`, which access a path beneath a root through an `openat(..., O_NOFOLLOW)` walk so a symlink below the root fails the operation instead of redirecting it. Unix only; other platforms throw `confine:unsupported`.
