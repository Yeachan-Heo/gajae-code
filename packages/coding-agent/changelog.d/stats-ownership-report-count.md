### Fixed
- `gjc stats` counted two gjc processes that recorded session ownership counts in the same millisecond as one process report. Each process's counts now carry their own report id. Counts recorded before this fix are still read, and are counted by write time as before.
