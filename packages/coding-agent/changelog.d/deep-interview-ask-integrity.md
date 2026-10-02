### Fixed

- Reject active deep-interview questions missing structured round metadata instead of accepting answers that cannot be recorded, and reject extra interview questions before prompting.
- Reject empty and whitespace-only ask question bodies, including metadata-free extra questions, in deferred, loaded, and direct execution paths while preserving ordinary multi-question and free-text asks, including next-workflow choices after final-spec handoff.
