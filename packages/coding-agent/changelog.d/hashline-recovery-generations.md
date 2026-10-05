### Fixed

- Hashline stale-anchor recovery now keeps 8 read-snapshot generations per file instead of 4. An edit that reuses anchors from a read 4–7 of the session's own edits ago can now be recovered instead of rejected.
