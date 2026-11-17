### Fixed

- Keep a published native runtime bound across its own view transitions. A revision, tree navigation or compaction advances the session view generation without adopting another transcript, and the binding used to treat that as a foreign takeover and refuse every later dispatch with `context_mismatch`. The binding now re-pins the generation only for transitions committed inside its own admitted dispatch, so a transition attempted from outside still fails closed.
- Adopt the resume cursor a durable execution selection committed, so a revision selection followed by another turn reconciles the cursor the session actually wrote instead of the superseded operation and its now-unknown suffix.
- Run the native `session` family outside the admission publication freeze. Revision and navigation own their own publication, so executing them while the dispatch still held the freeze failed with `publication_freeze_already_owned`.

### Added

- `currentEmbeddedResumeOperation(handle)` exposes the operation a native runtime currently reconciles, because a durable selection replaces the `op` the host received from `opened`.
