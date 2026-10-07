### Fixed
- Preserve explicit persistence identity in cross-manager session adoption (`restoreState`) even when snapshots are copied through documented caller-adjusted paths (spread, JSON round-trip, structuredClone); reconstruct identity from sessionFile for explicit-storage sessions to enable stale file checks.
- Reject copied snapshots whose serialized adopted artifact manager is no longer a live manager, preventing restore from installing an unusable plain object.
