### Fixed

- Managed tmux/psmux launches on Windows are rejected with the bounded reason `gjc_tmux_managed_launch_platform_unsupported:win32` before any provider probe, supervisor or session allocation, or lifecycle-state write, and are never retried as headless. The Broker does not reach this guard: Windows `session.spawn` selects the headless substrate before launch. Unmanaged Windows launches are unchanged.
