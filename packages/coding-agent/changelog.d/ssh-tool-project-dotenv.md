### Fixed

- The ssh tool now starts `ssh` (control master, host probe, and the remote command), `sshfs`, `mountpoint`, and the unmount helpers from the same filtered environment as the bash tool. Previously a repository `.env` declaring `LD_PRELOAD`, `NODE_OPTIONS`, `GIT_SSH_COMMAND` or another hook variable reached them. The control master, host probe and sshfs calls spread the process environment (into which the project `.env` is copied), so they leaked in the compiled binary too.
