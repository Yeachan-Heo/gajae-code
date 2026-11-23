### Fixed

- A detached `gjc harness start` launched without a UTF-8 locale (launchd, cron, a service manager) can start and clean up its tmux-resident owner again. The tmux clients that the harness runs on the owner's private socket now pass `-u`, like the managed-session clients fixed earlier. Before this, tmux replaced the tab in the session binding reply with `_`, so startup failed with `tmux-owner-native_session_identity_unproven` and cleanup reported `tmux-owner-cleanup_uncertain`. psmux and interactive attach are unchanged.
