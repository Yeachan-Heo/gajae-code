### Added
- Add an icon-only copy action below finished gajae responses, retrieving the complete canonical redacted answer instead of its truncated display preview.
- Bind copy reads to the current session and entry, exclude reasoning/tool/unfinished output, preserve native WebKit clipboard gestures, and expose actionable failure/retry without stale clipboard writes.

### Changed
- Managed response copying requires authoritative SDK transcript stop reasons; SDK support is tracked independently in #7585.
