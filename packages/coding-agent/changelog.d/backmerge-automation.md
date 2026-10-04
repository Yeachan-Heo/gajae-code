### Changed

- `bun run release` now syncs the released commit into `dev` automatically: after the atomic `main` + tag push it merges `main` into `dev` in a throwaway worktree, resolving only the `packages/natives/native/diagnostic-artifact.json` build-digest conflict, retrying when `dev` genuinely moved under the merge, and reporting a manual recovery path instead of failing an already-published release.
- The changelog guard keeps rejecting a release-consumed fragment deletion. The sync pushes `dev` directly, so that check never runs for it, and no content-based rule can prove that a release — rather than the pull request itself — folded a note: every such rule is forgeable by a diff that imitates a release fold.
