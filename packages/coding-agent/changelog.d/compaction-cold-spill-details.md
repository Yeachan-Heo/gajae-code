### Fixed

- Compaction now moves tool-result `details` (for example an MCP tool's full raw response with base64 screenshots) and large encrypted `thinkingSignature` values out of compacted history into cold storage. They used to stay in the transcript forever, so long-lived sessions such as 5-minute cron loops hit the 128 MiB per-file cap (`near_limit_rewrite`) within days and `/compact` could not recover them. Both rehydrate unchanged when read.
