### Fixed

- The restart notice printed by `gjc sdk broker attest-spawn-anchors --write` on Windows now says its commands are quoted for PowerShell, because cmd.exe passes the single quotes through literally. Its on-demand fallback now also says the next `gjc sdk session`, `search` or `spawn` command starts a broker only when broker autostart is on (not `GJC_SDK_BROKER_AUTOSTART=0`) and the command does not run with `--attach-only`.
