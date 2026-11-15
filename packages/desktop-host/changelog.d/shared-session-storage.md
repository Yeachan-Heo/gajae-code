### Changed

- New desktop conversations and forks are written to the SDK managed session store the terminal already reads, so the terminal can resume a conversation this app created. The catalog, project list, delivery journal and logs stay in the app's own data directory.
- The catalog records which root a transcript lives under and the SDK transcript identity, so reopening, discovery and deletion resolve the recorded file without duplicating a conversation. Catalogs written before this change keep opening from their existing private directory.
- A recorded managed transcript is deleted through the SDK's own managed deletion contract before its derived sidecars are cleaned up, and a conversation whose transcript another surface already removed can still be deleted instead of leaving a row that can never be opened.
- A conversation creation that never publishes now removes the transcript it created, and only after its writer is proven stopped.
- Deleting an unopened conversation whose transcript was removed elsewhere also cleans SDK-owned derived artifacts after durable catalog removal; missing JSONL no longer skips artifact cleanup.

### Fixed

- Retire every workspace and shutdown owner even when question publication or delivery persistence fails; join admitted work and terminal receipts without treating uncertain cleanup as success.
- Preserve explicit conversation order when discovering older transcripts, and renew prompt revision authority only after a factory-owned selected-entry fork settles.
- Stop request admission on malformed input or failed output, and release shutdown from an irrecoverably stalled output sink.
- Preserve native preference application and durability receipts through stale readback and transport errors; bind pull-request observations to the captured branch.
- Mask complete bounded display fields and normalized terminal/MCP text before display limits, withholding ambiguous credential-bearing transformations.

### Notes

- Storage is shared; runtime ownership is not. Stop a conversation in one surface before continuing it in the other. The app still treats a terminal conversation it merely discovered as attach-only, and neither surface currently holds an exclusive writer lease for a transcript.
