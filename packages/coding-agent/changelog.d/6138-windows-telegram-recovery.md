### Fixed

- Windows Telegram daemon stop and reload now wait for the owner-fenced cooperative control request before force escalation, and post-update recovery failures exit cleanly with actionable guidance instead of an uncaught exception (#6138).
- Added an owner-fenced control wakeup for blocked Telegram polls and extended hard-termination cooperative grace before escalation (#6138).
