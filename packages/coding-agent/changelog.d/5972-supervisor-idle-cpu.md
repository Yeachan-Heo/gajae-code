### Fixed

- The isolated bash shell supervisor no longer busy-spins while its shell is idle. It reaped adopted zombies by sweeping all of `/proc` every 25 ms without waiting for the previous sweep to finish, which kept each supervisor at about 160% CPU and tens of thousands of context switches per second even during `sleep`. Sweeps now run only on `SIGCHLD`, one at a time, so an idle supervisor stays near 0% CPU (#5972).
