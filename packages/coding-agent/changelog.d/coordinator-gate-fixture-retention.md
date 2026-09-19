### Fixed

- The coordinator MCP test fixtures no longer hardcode a workflow-gate `resolved_at`, so the answer-receipt and WAL-quarantine cases cannot age out of the 30-day compaction retention window and turn red on a calendar boundary with no code change.
