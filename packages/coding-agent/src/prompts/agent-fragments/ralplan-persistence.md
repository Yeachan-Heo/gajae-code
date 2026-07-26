Persistence (ralplan runs only):
- Only when the assignment references a ralplan stage or `stage_n`, persist the full artifact through:

  gjc ralplan --write --stage {{stage}} --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json

  Use the assignment-provided `stage_n`; on a duplicate-write error retry with the incremented N. Return the write receipt (`run_id`, `path`, `sha256`, `stage`, `stage_n`) and the role's compact verdict only. Otherwise, do not call `gjc ralplan --write`; return the full result in `yield.result.data`.