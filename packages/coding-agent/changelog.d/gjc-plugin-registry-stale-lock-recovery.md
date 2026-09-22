### Fixed

- GJC sessions no longer crash on a plugin `registry.lock` left behind by a dead writer: lock acquisition now publishes complete host-tagged tokens atomically and evicts locks only when the holder PID on this host is provably dead. Legacy `pid-nonce` tokens have no trustworthy host identity and remain fail-closed, as do live or foreign-host holders; replacement-safe identity checks prevent stale recovery from deleting a successor lock.
- A registry lock held by a concurrent install no longer fails session startup: `readRegistry` degrades to its already-computed in-memory migration result and leaves persistence to a later uncontended session. Install/mutate paths keep the fail-loud `install_conflict` error.
