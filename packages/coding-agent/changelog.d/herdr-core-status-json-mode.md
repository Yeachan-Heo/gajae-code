### Fixed

- The herdr-core OSC 7501 status report no longer writes into `--mode json` or `-p` output when stdout is a PTY in an `hc` terminal; only interactive sessions report (#7525).
- The status retraction on exit now writes the whole sequence when a nonblocking terminal accepts only part of it, so herdr-core does not keep a stale status (#7525).
