### Fixed

- A session resumed in a new process (`--resume`/`--continue`) no longer has its first Telegram notifications silently suppressed. Every SDK host start now opens an event generation no lower than its wall-clock start time instead of restarting at `1`, so the new process's `(generation, seq)` coordinates and notification publication ids can no longer collide with delivery receipts recorded for the previous process. The Telegram daemon resumes a stored replay cursor only within the host generation that produced it.
