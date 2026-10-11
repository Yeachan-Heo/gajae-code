### Fixed

- Temp directory cleanup on Windows: sessions now properly release managed sidecar cache file handles during `closeStrict()`, preventing "directory in use" errors when deleting temporary session directories in tests. The root cause was unconditional resource retention when close succeeded; the fix ensures file handles are released even when resident blob cleanup is skipped (#6566).
