### Fixed

- **bus host** — operator turn.abort (mode terminal, operator:true) now correctly stops terminal-initiated turns (those started by the TUI or host, not SDK submissions) instead of returning no_active_turn. The bus host now matches the SDK-only host behavior and the documented contract in docs/sdk-session-cli.md. Fixes #7566.
