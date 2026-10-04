### Changed

- `bun run release` now syncs the released commit into `dev` automatically: after the atomic `main` + tag push it merges `main` into `dev` in a throwaway worktree, resolving only the `packages/natives/native/diagnostic-artifact.json` build-digest conflict, retrying when `dev` moves under the merge, and reporting a manual recovery path instead of failing an already-published release.
- The changelog guard no longer reports the release flow's own fragment consumption as a violation: a fragment deleted by a `main`→`dev` backmerge is exempt when its note already appears in the head CHANGELOG, while a deleted fragment whose note never landed is still rejected.
