### Fixed

- Report a retained heartbeat-renewal block as a broker exit instead of silently dropping the checkpoint cycle. A heartbeat pass whose budget aborted before the lock layer exhausted reported nothing, so a broker blocked by a stale removal transition lingered until shutdown; it now surfaces the block and exits with `heartbeat-renewal-blocked` and the blocking lock path (#6738).
- Keep the retained broker trampoline's decision backstop longer than the parent's discovery deadline so a broker that never publishes is reported as a discovery timeout rather than an "exited before discovery" startup failure (#6738).
