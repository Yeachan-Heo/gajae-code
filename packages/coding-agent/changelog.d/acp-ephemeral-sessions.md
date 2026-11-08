### Added

- ACP clients can now create temporary sessions by sending `session/new` with `_meta.gjc.ephemeral: true`, after checking that initialization advertised `_meta.gjc.ephemeralSessions: true`. A temporary session keeps its transcript in memory only. It never appears in `session.list` and cannot be loaded or resumed. Only the ACP agent that created it can reattach it after a transient transport drop; if that is impossible, prompts fail with `ephemeral_session_unrecoverable` (#7431).
