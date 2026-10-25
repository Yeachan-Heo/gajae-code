### Fixed

- Managed tmux shutdown works on macOS: the supervisor relays SIGTERM to its child through its own spawn handle, and `forceCloseGjcTmuxSession` closes a managed owner through a generation-fenced owner intent that succeeds only after both supervisor exit and the matching terminal verdict, instead of failing with `managed_owner_supervisor_signal_failed`.
- A macOS managed close that arrives before the supervisor has published its binding now waits, within the close deadline, for that same exact supervisor's binding instead of failing once with `managed_owner_binding_unavailable`; untrusted, ambiguous, or replaced supervisor evidence still fails closed.
