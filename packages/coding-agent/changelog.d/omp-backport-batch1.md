### Fixed

- Keeps other queued messages when compaction-queue flush fails, only removing user input queued during delivery attempt (port omp 27ff9369b7)
- Rearmed idle compaction timer when idle compaction enabled state, threshold, or delay changes while session is already idle (port omp 9f38657b39)
- Auto-compaction enable now uses system default strategy instead of hardcoding "context-full" (port omp 3c356fc0e0)
- Compact limit labels now show correct fractions (1/8, 1/4, 1/2, 3/4) instead of incomplete descriptors (port omp 1a0cfc12b2)
