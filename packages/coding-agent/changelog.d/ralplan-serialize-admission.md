### Fixed

- Ralplan writes now hold a cross-process per-run admission lock from ledger snapshot through budget evaluation, artifact publication, and ledger append. Concurrent lane writes can no longer both consume the same remaining review slot; stale run IDs are also prevented from reclaiming the active session state.
