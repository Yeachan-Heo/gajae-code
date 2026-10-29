### Fixed

- Windows `session.spawn` selects the headless substrate before any managed launch, so a Broker spawn never reaches the managed Windows rejection (`gjc_tmux_managed_launch_platform_unsupported:win32`) and that rejection is never retried as headless. Unmanaged Windows launches are unchanged.
