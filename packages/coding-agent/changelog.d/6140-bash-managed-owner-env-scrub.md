### Fixed

- Nested `gjc` commands run through the Bash tool inside a managed-owner (tmux-supervised) session no longer fail with `managed_owner_admission_metadata_invalid`: the Bash boundary now scrubs the whole managed-owner env family, including the tmux owner server key and `GJC_TMUX_LAUNCHED`, instead of leaving a partial owner context behind (#6140).
