### Fixed

- Managed tmux shutdown works on macOS: the supervisor relays SIGTERM to its child through its own spawn handle, and `forceCloseGjcTmuxSession` closes a managed owner through a generation-fenced owner intent that succeeds only after both supervisor exit and the matching terminal verdict, instead of failing with `managed_owner_supervisor_signal_failed`.
