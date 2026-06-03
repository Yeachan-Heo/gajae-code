Lists, inspects, awaits, pauses, resumes, steers, or cancels detached task subagents.

Task launches return immediately. Use this tool when you need direct control over those running subagents. Prefer `subagent` for task subagents; generic `job` remains available for non-subagent jobs and compatibility fallback access.

# Operations

## `action: "list"`
Snapshot your visible detached subagents, including `running`, `paused`, `queued`, and terminal subagents when retained.

## `action: "inspect"`
Inspect selected subagents by `ids`; omit `ids` to inspect current running subagents. Terminal subagents include final output when retained.

## `action: "await"`
Wait for selected subagents by `ids`; omit `ids` to wait for current running subagents.
- Always set `timeout_ms` when the result is not immediately required forever.
- Await timeout only bounds this tool call's wait; it does not stop the subagent and is not a failure reason.
- On timeout, inspect progress and keep doing independent work. Never cancel just because an await timed out; cancel only if the subagent has actually failed, gone off-track, or become unrecoverably wrong.

## `action: "pause"`
Request a graceful safe-boundary pause for selected subagents by `ids`.
- Non-running subagents are a no-op and return their current status snapshot.
- A paused subagent keeps its session context and can be resumed later.

## `action: "resume"`
Resume selected non-running subagents by `ids`.
- Optional `message` is delivered into the resumed run.
- Running subagents are a no-op and return their current status snapshot.
- Terminal subagents require `message` to start a follow-up resume run; without `message`, the tool returns the current snapshot with guidance.
- `paused` subagents resume from saved context; `queued` subagents are already waiting for capacity.

## `action: "steer"`
Send a non-empty `message` to selected subagents by `ids`.
- Running subagents receive the message through their live handle.
- Optional `pause: true` requests a safe-boundary pause after steering a running subagent.
- `pause` only matters while the target is running.
- Non-active subagents (`paused`, `queued`, or terminal) automatically resume with the message; `pause` is ignored for these targets.

## `action: "cancel"`
Stop selected subagents by `ids`, including running, paused, or queued subagents.
- Use only when the subagent has actually failed, gone off-track, or become unrecoverably wrong; an await timeout alone is never a cancellation reason.
- Cancellation keeps the subagent session file for possible later context recovery.

# Statuses

- `running` — currently executing.
- `paused` — stopped at a safe boundary with resumable context.
- `queued` — resume requested and waiting for execution capacity.
- `completed` — finished successfully.
- `failed` — finished with an error.
- `cancelled` — stopped by cancellation.
- `not_found` — no visible subagent matches the requested id.
