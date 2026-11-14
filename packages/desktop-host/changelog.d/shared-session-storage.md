### Changed

- New desktop conversations and forks are written to the SDK managed session store the terminal already reads, so the terminal can resume a conversation this app created. The catalog, project list, delivery journal and logs stay in the app's own data directory.
- The catalog records which root a transcript lives under and the SDK transcript identity, so reopening, discovery and deletion resolve the recorded file without duplicating a conversation. Catalogs written before this change keep opening from their existing private directory.
- A recorded managed transcript is deleted through the SDK's own managed deletion contract before its derived sidecars are cleaned up, and a conversation whose transcript another surface already removed can still be deleted instead of leaving a row that can never be opened.
- A conversation creation that never publishes now removes the transcript it created, and only after its writer is proven stopped.

### Notes

- Storage is shared; runtime ownership is not. Stop a conversation in one surface before continuing it in the other. The app still treats a terminal conversation it merely discovered as attach-only, and neither surface currently holds an exclusive writer lease for a transcript.
