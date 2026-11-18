### Fixed

- The Telegram notification daemon now keeps at most 4,096 completed cleanup receipts, evicting the oldest first. Completed receipts were never removed, so a long-lived install grew `telegram-presentation-state.json` without bound and rewrote the whole file on every session removal. Pending and failed receipts are kept, and a state file written before this bound shrinks on the next daemon start.
