### Added
- `gjc session owners` lists which processes hold sessions open for writing: claims held by this process or the gjc it runs under, every other held session with its surface, pid and how long it has been held, and the owners directory's sidecar count and size on disk. `--json` gives the same report as JSON. It only reads: it never takes, breaks or rewrites a lock or record, and creates nothing on a machine where no session was ever claimed. Session ownership is still off by default, so the list stays empty until it is turned on.

### Fixed
- A session holder record's `claimedAt` is shown only when it is a plain UTC timestamp, so a malformed record can no longer put arbitrary text into ownership output.
