### Fixed

- Managed tmux/psmux launches on Windows are rejected with the bounded reason `gjc_tmux_managed_launch_platform_unsupported:win32` before any provider probe, supervisor or session allocation, or lifecycle-state write; the Broker reports `substrate_proof_failed` and never falls back to headless. Unmanaged Windows launches are unchanged.
