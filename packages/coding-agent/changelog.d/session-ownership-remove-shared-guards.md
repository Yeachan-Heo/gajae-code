### Removed

- SDK embedders: `SessionManager` no longer has the shared-mutation guards `assertLegacyMutationAllowed()`, `assertLegacyAppendAllowed()`, `requiresSharedMutationAdmission()` or `withDurableThinkingControl()`, and `AgentSession` no longer has `assertConfiguredModelChainWritable()`. They could only refuse after a shared publication, which no session makes any more, so they never refused: drop the guard calls, and call a `withDurableThinkingControl()` body directly. `SharedSessionMutationUnsupportedError` is gone with them.
- SDK embedders: `GraphSuccessorRefusal` narrows to the refusals a fork or branch can still meet: `unknown-entry`, `unreadable` and `changed`. `GraphSuccessorUnavailableError` now extends `Error` instead of `SharedSessionMutationUnsupportedError` and no longer has its `code`. `SessionManager.graphSuccessorRefusal()` takes the branch entry id (`graphSuccessorRefusal(leafId)`); its whole-session and no-argument forms always answered `undefined` and are gone.

### Changed

- SDK embedders: `SharedControlPublicationError` is renamed `SessionControlReplacedError`, after the one refusal it reports: a control whose session was replaced (a fork) while it awaited. Its constructor takes only the operation, and the `outcome` field and the error `cause` are gone. `code` stays `rejected` and the message is unchanged.
