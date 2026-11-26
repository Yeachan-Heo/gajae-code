### Fixed

- **Session transcript size**: Stop persisting `displayContent` from tool result details (read, search, ast_edit, ast_grep tools). This field contained full formatted text used only for TUI rendering and was not needed for resume/replay functionality. Measured impact: ~4.3KB per read tool result details JSON without displayContent; cumulative fixture with 10 reads shows <100KB total. Tool renderers have fallback logic to reconstruct text from raw content when displayContent is unavailable.

- **Emergency compaction loop**: Prevent infinite emergency compaction when transcript file cannot shrink further. Track file size after `transcriptFile` emergency compaction; only re-trigger if file grows by >50% since last compaction (1.5x threshold). This prevents repeated compaction on every prompt when the file is at the emergency floor but cannot shrink further.

- **UI notices for emergency compactions**: Update auto-compaction start event to include specific emergency reason (transcriptFile, heap, retainedMemory, etc.) instead of always showing generic 'Context overflow'. UI displays context-appropriate messages (e.g., 'Transcript size floor exceeded' for transcriptFile).
