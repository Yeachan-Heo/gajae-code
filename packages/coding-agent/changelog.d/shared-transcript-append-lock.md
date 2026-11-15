### Fixed

- Two TUIs or SDK writers appending to the same shared session transcript now serialize their appends through an owner-only lock under `~/.gjc/runtime/append-locks`, so their JSONL records no longer interleave ([#7771](https://github.com/Yeachan-Heo/gajae-code/issues/7771)). The lock is keyed by the transcript's canonical directory and case-folded name, so case aliases share it even before the file exists. A writer refuses to append if the lock directory chain was replaced after setup, or if the home directory is writable by another user.
