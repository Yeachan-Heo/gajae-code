### Fixed

- Contain rejections from `async` agent-session event subscribers, so a failed subscriber write (for example the `managed_append_identity_mismatch` fence after another process resumed the same session) is logged instead of terminating the interactive process with an unhandled rejection.
