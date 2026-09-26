### Fixed

- Pressing Enter while a turn is streaming no longer kills the interactive session with an unhandled `managed_append_identity_mismatch` rejection. When another process resumed the same session (for example a second `gjc -c`), the managed append fence correctly refused the stale writer, but the editor submit handler dropped the promise returned by `submitText`, so the rethrown fence error escaped as a process-fatal unhandled rejection. Rejected editor submissions are now reported through the normal error line and the input loop stays usable; the append fence itself is unchanged.
