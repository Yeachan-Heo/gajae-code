### Fixed

- Session host abandonment now distinguishes an attached-but-idle chat daemon from active work. Notification adapters identify themselves as observers, while in-flight prompts still keep their host alive, and session activity rows now persist the host's observed active/idle state instead of rewriting every live heartbeat to `active`.
