### Fixed

- Resuming a closed session (`--resume`/`--continue`) while the Telegram notification daemon keeps running opens a fresh forum topic and delivers notifications again. The `session_closed` tombstone now fences only the attachment that closed, not every later attachment for the same session id, and refused attachment recovery leaves a daemon warning instead of silently dropping the subscription.
