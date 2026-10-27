### Fixed

- Managed tmux sessions start from a Broker launched without a UTF-8 locale (launchd, cron, a service manager). The native tmux clients that managed-session creation, inspection, and mutation run and parse now pass `-u`. Before this, tmux replaced the tab separators in their replies with `_`, so creation failed with `gjc_tmux_owner_changed_after_create`, and non-ASCII workspace paths did not round-trip through the session state-file tag. psmux and interactive `attach-session` are unchanged.
