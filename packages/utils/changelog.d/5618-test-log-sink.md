### Fixed
- Isolate the test log sink so `bun test` no longer appends fixture `level:error` records to the operator's shared `~/.gjc/logs/gjc.<date>.log`. The rotating file transport now honors `GJC_LOG_DIR`, and the test preload pins it to a per-process temp directory.
