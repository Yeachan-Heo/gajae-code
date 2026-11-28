### Fixed

- Under `session.ownership.mode: enforce`, starring, unstarring or deleting a session in the `--resume` picker or the TUI's `/resume` picker no longer rewrites or removes a transcript another gjc process has open. The picker shows `Can't star this session: it is open in another terminal (pid N).` (or `delete`), and the holder keeps working on an intact transcript. `SessionManager.dropSession` and `SessionManager.deleteManagedCandidate` refuse the same way.
  - Each write claims the session only while it runs, then releases it. A session the same process already holds, such as the current one, is never refused.
  - Under `observe`, these writes go ahead as before, and the conflict is logged and counted as `claim_conflict`. `off` makes no lock call.
