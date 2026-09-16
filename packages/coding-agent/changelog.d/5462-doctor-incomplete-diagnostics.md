### Fixed

- `gjc doctor --fix` now refuses to plan a repair when a selected collector timed out or was cancelled and is therefore still writing to the shared diagnosis context. The action is reported as `blocked` with reason `incomplete_diagnostics` and exit 3, while the diagnosis still shows everything that was collected.
