### Fixed

- Resident text blobs for long assistant and tool output stay in memory when the resident cache root is inside a Git worktree, so a later git add cannot stage that plaintext.
