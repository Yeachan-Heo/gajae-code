### Added
- Carry captured endpoint configuration through compaction, handoff, turn-prefix, and branch-summary options into their actual provider requests, including native OpenAI compaction.
- Reject forged configuration handles before maintenance fallback or network access; captured proxy absence does not adopt a later proxy, and OAuth compaction retains its canonical origin.
