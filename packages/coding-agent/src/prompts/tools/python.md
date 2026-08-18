Execute Python in the persistent autoresearch mission kernel.

Variables, imports, and loaded data persist across calls like notebook cells, and every call is recorded as a cell in the mission notebook so the synthesized report can replay the work.

## When to use

Use this during an `autoresearch` mission whose mode is `data` or `mixed`, for loading datasets, running measurements, and iterating on analysis. Prefer it over `bash` one-shots (`python -c`, `python -e`) for anything stateful: those lose all state between calls and produce no notebook record.

For ordinary one-off code execution outside a mission, use `eval` instead. `eval` runs in a session-scoped kernel; this tool runs in a kernel owned by the mission.

## Actions

- `execute` (default) — run `code` in the mission kernel. Requires `code`.
- `clear` — dispose the mission kernel subprocess. The next `execute` starts a fresh kernel with no retained state. Use it when a mission is finished, or to recover from a wedged interpreter.

## Requires an active mission

The mission is resolved on every call from the current session's autoresearch state. With no active mission this tool refuses and tells you to start one with `gjc autoresearch`. It will never quietly fall back to a session-scoped or ad-hoc kernel, so a refusal means the mission is genuinely missing or its state is unreadable — fix that rather than retrying.

The kernel is owned by the mission, not the session, so it is reaped when the mission clears it and again when the session ends, including on interrupt.
