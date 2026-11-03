### Added

- gjc reports its lifecycle (idle, working, blocked on `ask`) through OSC 7501 when it runs in a herdr-core (`hc`) terminal, including the Herdr desktop app, so it appears in Herdr's Agents sidebar and works with `hc wait` and `hc send`'s blocked guard. The report is retracted on exit. The herdr TUI integration (`HERDR_ENV`) is unchanged.
