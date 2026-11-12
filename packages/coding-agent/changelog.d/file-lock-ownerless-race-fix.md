### Fixed

- fix(file-lock): remove age-only reclamation that enabled legacy-publisher race condition. Ownerless empty lock directories are no longer reclaimed based on age alone; durable evidence of owner death is now required. This prevents a still-paused legacy publisher from resuming into a successor's already-published canonical lock, which violated mutual exclusion. Fixes #7744.
