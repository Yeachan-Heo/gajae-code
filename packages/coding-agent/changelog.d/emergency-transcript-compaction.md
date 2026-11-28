### Fixed

- **Emergency compaction loop**: Prevent infinite emergency compaction when transcript file cannot shrink further. Track file size after `transcriptFile` emergency compaction; only re-trigger if file grows by >50% since last compaction (1.5x threshold). This prevents repeated compaction on every prompt when the file is at the emergency floor but cannot shrink further. Added cap-aware threshold calculation to ensure compaction retry threshold respects the 128MiB managed transcript cap.

- **Auto-compaction event context**: Include emergency reason in auto_compaction_start event when triggered by resource floor breach (transcriptFile, heap, retainedMemory, providerBytes, imageBytes, messageCount), enabling UI to show context-appropriate status messages.
