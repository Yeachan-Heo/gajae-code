### Removed

- SDK embedders: `SessionManager` no longer has the rest of the shared-publication layer: `appendMessageSharingSession()`, `appendThinkingLevelChangeSharingSession()` and `withSharedThinkingControl()`. The `SharedAppendOutcome` and `SharedEntriesAppendOutcome` types and the `SessionManagerTestHooks.beforeSharedAppendPublish` hook are gone too. Use the ordinary appends (`appendMessage()`, `appendThinkingLevelChange()` and the rest): every session writes its transcript through them.
