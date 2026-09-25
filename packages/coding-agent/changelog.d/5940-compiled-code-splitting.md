### Changed
- Compiled `gjc` binaries now use code splitting, so lazily imported modules load only when needed. Measured on a linux-x64 build (15 interleaved samples), `gjc --version` drops from 700 ms and 162 MB max RSS to 200 ms and 81 MB, and `gjc --help` drops from 700 ms and 162 MB to 190 ms and 81 MB. Internal bash helper processes use about half as much RSS.

### Fixed
- Fixed `scripts/verify-rss-checkpoints.ts` rejecting successful samples on Linux. The measured Bun child left the shared stderr pipe non-blocking, so GNU `time` failed to write its report (EAGAIN) and exited 1. The report now goes to a file.
