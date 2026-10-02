### Fixed

- Reverted the 0.18.2 readiness-cutoff reaping (#6126) because it left hosts in `terminal_uncertain` under concurrent recovery (#6143); unregistered hosts terminated by a signal at readiness cutoff again report `terminal_uncertain` until the fix re-lands.
