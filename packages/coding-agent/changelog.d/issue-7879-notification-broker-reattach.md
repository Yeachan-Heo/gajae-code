### Fixed

- Telegram notification bus now properly re-registers with a successor broker when the initial SDK broker registration failed. Sessions no longer keep stale generation heartbeats for hours; when a broker generation changes, the notification bus now properly transitions from the old to the new generation (#7879).
