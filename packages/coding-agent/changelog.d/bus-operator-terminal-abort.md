### Fixed

- A Broker-routed operator `turn.abort` (`mode: "terminal"`, `operator: true`) now stops a turn typed at the terminal of a notifications-enabled TUI, as it already did on a TUI with notifications off. The notifications host only looked for SDK-submitted turns, so it answered `no_active_turn` / `terminal_no_effect` and the turn kept running. Operator authority now targets the session's active run observed at admission, and the terminal shows `Turn stopped by a remote operator.` A peer SDK connection without operator authority still cannot stop a turn it did not submit (#7566).
