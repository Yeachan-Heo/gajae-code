### Fixed

- On macOS, the shell runtime no longer exits with code 70 when spawning fast-exiting child processes or entitled/setuid children (like `/bin/ps`, `/usr/bin/top`, `sudo`) that cannot be queried for unique identity. When a child is confirmed absent or terminated before observation, the process identity is recorded like on Linux. Only genuine integrity failures (ledger write failures, HMAC errors) trigger exit 70 on a live child (#6085).
