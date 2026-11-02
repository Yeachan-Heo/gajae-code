### Fixed

- A managed tmux launch (Broker child or root `--tmux` launch) whose session state tail, or session directory, is a symbolic link no longer creates an empty owner-only `owner-lifecycle` directory inside the link target before refusing the launch. Lifecycle root preparation now checks every existing path component with `lstat` first and refuses a link or non-directory before creating anything. The macOS system aliases `/tmp`, `/var` and `/etc` stay accepted, as in the native verification.
