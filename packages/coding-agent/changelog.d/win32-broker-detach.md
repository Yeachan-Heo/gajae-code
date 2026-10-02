### Fixed

- Windows SDK broker now uses an intermediate 'hop' process to spawn with `detached:true`, allowing the broker to survive parent tree termination (taskkill /T /F). The hop exits immediately after spawning the real broker with detached mode and windowsHide, breaking the process tree chain. This avoids cmd.exe wrapping complexity (quoting, variable expansion, discovery matching) while ensuring broker survival across force-termination scenarios (issue #6007).
