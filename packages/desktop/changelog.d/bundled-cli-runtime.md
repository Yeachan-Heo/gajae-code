### Fixed
- Bundle the real `gjc` CLI alongside the SDK host so app workflow commands and subprocesses require no separate global CLI or Bun installation. SDK child modes dispatch through the real CLI while preserving existing ownership checks.
