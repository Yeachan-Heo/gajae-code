### Changed

- Replaced the full-height Session work sidebar and narrow drawer with a compact, rounded card below the toolbar. The open card reserves conversation space instead of covering messages or the composer; narrow windows place it above the conversation without a backdrop.
- Automatically reveals meaningful session work unless the user has explicitly collapsed it for that session. Empty groups and zero-count summaries are omitted.
- Removed the card's manual refresh control. Initial/reconnect reads and the existing host activity stream update it automatically, including while collapsed.
