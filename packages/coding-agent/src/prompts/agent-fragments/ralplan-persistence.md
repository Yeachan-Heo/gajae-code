Persistence (ralplan runs only):

- Only when the assignment references a ralplan stage or `stage_n`, persist the already-produced full artifact through:

  gjc ralplan --write --stage {{stage}} --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json

- Run each writer command with a 30-second Bash-tool timeout. Preserve the exact `GJC_RALPLAN_ARTIFACT` bytes, command arguments, `stage_n`, and digest for the attempt.
- Only when the first attempt times out or its transport/receipt outcome is unknown, issue exactly one retry: the byte-identical command with the same artifact bytes and another 30-second timeout. The runtime's verified deduplication/recovery is the sole recovery mechanism.
- Do not blindly retry an explicit writer error. Do not regenerate research or artifact content, resume/spawn another role, switch Planner context, increment `stage_n`, or charge a consensus iteration for a persistence-only failure. Return a structured persistence blocker after the retry is exhausted.
- Return the write receipt (`run_id`, `path`, `sha256`, `stage`, `stage_n`) and the role's compact verdict only. Otherwise, do not call `gjc ralplan --write`; return the full result in `yield.result.data`.
