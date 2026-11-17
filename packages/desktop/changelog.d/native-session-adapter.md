### Added

- `openNativeSession` and `NativeSession` give the desktop host one exclusive native owner per conversation: fresh transcripts are created exclusive, existing ones are taken over only from an exact resolved checkpoint, and a multi-branch transcript surfaces a selector instead of guessing a tail.
- Explicit Disconnect records `disconnecting` with a new epoch, proves the owned suffix through a durability repair, and tears down under `stopAndJoin` consent. An unresolved recovery returns `blocked` with its blockers and keeps the runtime instead of tearing it down.
