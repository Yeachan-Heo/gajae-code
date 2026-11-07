### Changed

- New desktop conversations and forks are written to the SDK managed session store the terminal already reads, so both surfaces resume the same transcript instead of keeping separate histories. The catalog, project list, delivery journal and logs stay in the app's own data directory.
- The catalog records which root a transcript lives under and the SDK transcript identity, so reopening, discovery and deletion resolve the recorded file without duplicating a conversation. Catalogs written before this change keep opening from their existing private directory.
- A conversation creation that never publishes now removes the transcript it created, and only after its writer is proven stopped.
