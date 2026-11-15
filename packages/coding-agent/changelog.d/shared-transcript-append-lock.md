### Fixed

- Two TUIs or SDK writers appending to the same shared session transcript now serialize their appends through an owner-only lock under `~/.gjc/runtime/append-locks`, so their JSONL records no longer interleave ([#7771](https://github.com/Yeachan-Heo/gajae-code/issues/7771)). The lock is keyed by the transcript's on-disk spelling, so case aliases on Windows share it, and a writer refuses to append if the lock directory chain was replaced after setup.
