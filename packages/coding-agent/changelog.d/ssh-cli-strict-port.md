### Fixed

- `gjc ssh add --port` now rejects ports that are not plain digits (`"22oops"`, `"2222.5"`, `"+22"`, `"1e3"`) instead of silently saving the leading digits to `ssh.json`.
