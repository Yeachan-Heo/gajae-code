### Added

- `AssistantMessage.credentialId` records the stored credential row that authenticated the request producing the message. `streamSimple` stamps `StreamOptions.credentialId` on every partial, the `done` or `error` message, and the stream result; an auth retry that returns an `AuthRetryCredential` with its own `credentialId` attributes the retried response to that row, while a bare replacement key leaves the field unset. The value is the opaque, non-secret row id only, and it is never set for external, env, or pi-native gateway keys.
