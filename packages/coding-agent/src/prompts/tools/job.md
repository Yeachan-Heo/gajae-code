Inspects, waits, or cancels async jobs.

Background job results are delivered automatically when complete. Running job output stays quiet by default to avoid flooding the conversation; use `tail` when you explicitly want to show/reopen retained output. Reach for this tool only when you need to inspect or intervene.

# Operations

## `list: true`
Use to inspect what's running.

## `tail: [id, …]`
Show the retained output buffer for one or more background jobs without waiting.
- Use this to reopen/tail a backgrounded long-running bash/tool output after folding it away.
- Output is bounded by the manager retention window; stale cursors may report that only the retained tail is available.
- Prefer `tail` over polling when you only need to peek at progress, so the conversation can continue without flooding the TUI.

## `poll: [id, …]`
Block until the specified jobs finish or the wait window elapses.
- Use when you are genuinely blocked on a result and have no other work to do.
- Returns the current snapshot when the timer elapses; running jobs remain running.
- Completed jobs include their final output in the returned snapshot.

## `cancel: [id, …]`
Stop running jobs.
- Use when a job is stalled, hung, or no longer needed.
- Returns immediately after cancelling.
