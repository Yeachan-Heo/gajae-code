### Fixes

- Flush pending agent_end event after auto-compaction completes to prevent "Timed out waiting for prior agent run to finish" error on the next prompt. When the session is loaded in a new process after compaction, the in-memory agent_end event is lost, causing the next prompt() call to timeout. Fixes #6004.
