Persistence (ralplan runs only):
- Only when the assignment references a ralplan stage or `stage_n`, it must also provide the ralplan owner `session_id` and `run_id`. If either identifier is missing, do not persist; return a compact error asking the caller to supply both.
- Persist the full artifact through:

  gjc ralplan --write --session-id <owner-session-id> --run-id <run-id> --stage {{stage}} --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json

  Use the assignment-provided owner `session_id`, `run_id`, and `stage_n`; never substitute the role subagent's own session id. On a duplicate-write error retry with the incremented N. Return the write receipt (`session_id`, `run_id`, `path`, `sha256`, `stage`, `stage_n`) and the role's compact verdict only. Otherwise, do not call `gjc ralplan --write`; return the full result in `yield.result.data`.