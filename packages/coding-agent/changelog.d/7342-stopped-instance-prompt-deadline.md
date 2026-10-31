### Fixed

- A stopped SDK host instance no longer terminalizes a still-pending prompt when its deadline timer fires after `session_shutdown`. That late write rewrote the session's reconciliation store from the stopped instance's stale record set, so a successor instance in the same process could lose its own persisted prompt results (a `turn.result` query then answered `unknown`). The pending record now stays for restart recovery, as it would after a process exit (#7342).
