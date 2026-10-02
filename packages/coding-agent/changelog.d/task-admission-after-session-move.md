### Fixed

- Allow new tasks to use the committed target repository after an authorized session move, including previously materialized task tools, while preserving admitted tasks' execution scope, repository checks, and output ownership.
- Keep managed persistent task outputs and live child transcripts on a verified stable session-tree owner across parent moves and reopening; retire that exact owner through managed deletion and disk GC without changing ephemeral or adopted artifact allocation.
