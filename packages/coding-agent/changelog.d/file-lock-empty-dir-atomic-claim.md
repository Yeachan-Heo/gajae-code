### Fixed

- Replace file-lock empty-directory cleanup with atomic ownership-claim design to resolve concurrent claim races. Verify identity of stale empty locks and claim ownership using exclusive-create (O_EXCL) instead of rmdir for correct POSIX semantics across Linux and Windows. Test all platforms with deterministic ABA-race scenarios; reclaim old empty lock directories on Windows immediately upon identity verification.
