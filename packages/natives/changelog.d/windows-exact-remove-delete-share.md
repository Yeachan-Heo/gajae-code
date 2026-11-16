### Fixed

- Windows `exactRemoveDirectoryTree` no longer fails every non-empty removal with `sharing_violation` by holding the directory it quarantines children into with DELETE, and no longer leaks child handles on failed removals. This stops the SDK broker from wedging its session index after the first lock contention on Windows 10.
