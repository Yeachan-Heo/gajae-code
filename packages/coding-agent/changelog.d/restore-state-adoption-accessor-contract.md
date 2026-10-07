### Fixed
- Preserve explicit persistence identity in cross-manager session adoption (`restoreState`) even when snapshots are copied through documented caller-adjusted paths (spread, JSON round-trip, structuredClone); reconstruct identity from sessionFile for explicit-storage sessions to enable stale file checks.
