### Fixed

- Windows SDK broker now uses an intermediate 'hop' process to spawn with `detached:true`, allowing the broker to survive parent tree termination (taskkill /T /F). The hop exits immediately after spawning the real broker with detached mode and windowsHide, breaking the process tree chain. This avoids cmd.exe wrapping complexity (quoting, variable expansion, discovery matching) while ensuring broker survival across force-termination scenarios (issue #6007).
- On macOS, SDK broker discovery retains the detached child handle for safe cleanup after startup failures without signaling a potentially reused PID.
