### Changed

- Add opt-in shared publication for canonical messages and workflow intent records, awaiting committed intent before provider dispatch or busy-input queue acceptance. Uncertain publication retains its attempted entry evidence without retrying legacy writes.
- Keep CLI and SDK factory defaults unchanged. This publication core does not activate shared TUI mode or enable shared thinking, title, rename, or star controls.
