Lists, inspects, awaits, pauses, resumes, steers, or cancels detached task subagents.

Task launches return immediately. Use this tool when you need direct control over those running subagents. Prefer `subagent` for task subagents; generic `job` remains available for non-subagent jobs and compatibility fallback access.

`verbosity` controls output size: `receipt` (default) returns status metadata plus a single ≤280-character result/error preview and an `agent://<id>` output ref when available; `preview` returns ≤2000 characters; `full` returns ≤12000 characters and requires explicit `ids`.

# Operations

## `action: "list"`
Snapshot your visible detached subagents, including `running`, `paused`, `queued`, and terminal subagents when retained. Optional `limit` (1–50) caps how many subagents are returned. Output is receipt-only by default; use `verbosity: "preview"` for a bounded preview or inspect explicit `ids` with `verbosity: "full"` when fuller retained text is necessary.

## `action: "inspect"`
Inspect selected subagents by `ids`; omit `ids` to inspect current running subagents. Terminal subagents return receipt-only output by default, with an `agent://<id>` ref when a verified output artifact is available. `verbosity: "full"` requires explicit `ids`.

## `action: "await"`
Wait for selected subagents by `ids`; omit `ids` to wait for current running subagents.
- `mode` (optional): `"bounded"` (default) or `"until_terminal"`.
  - **bounded**: uses `timeout_ms` (default 30000). Good for short checks and independent work loops.
  - **until_terminal**: waits in a single tool call until the join condition is met or `deadline_ms` (default 600000 / 10 min) expires. Prefer this for long reviewers and other multi-minute children so you do not re-poll every 30s.
- `deadline_ms` (optional): hard wait cap for `until_terminal` only. On expiry, `awaitOutcome` is `timed_out` and the child keeps running.
- `heartbeat_ms` (optional): sparse `onUpdate` progress interval for `until_terminal` (default 120000; `0` disables heartbeats). Does not cause artificial timeouts.
- `join` (optional): `"all_terminal"` (default, wait for every watched job) or `"any_terminal"` (resolve when any watched job reaches a terminal status; final snapshots still cover all requested ids).
- Always set `timeout_ms` (bounded) or `deadline_ms` (until_terminal) when the result is not required for the full default window.
- Await timeout/deadline only bounds this tool call's wait; it does not stop the subagent and is not a failure reason.
- On timeout, inspect progress and keep doing independent work. Never cancel just because an await timed out; cancel only if the subagent has actually failed, gone off-track, or become unrecoverably wrong.
- Completed results are receipt-first by default: bounded preview plus `agent://<id>` output ref when available, not full retained output.

## `action: "pause"`
Request a graceful safe-boundary pause for selected subagents by `ids`.
- Non-running subagents are a no-op and return their current status snapshot.
- A paused subagent keeps its session context and can be resumed later.

## `action: "resume"`
Resume one subagent by `id` (preferred) or a single-item `ids` array.
- Optional `message` is delivered into that one resumed run.
- Running subagents are a no-op and return their current status snapshot.
- Terminal subagents require `message` to start a follow-up resume run; without `message`, the tool returns the current snapshot with guidance.
- `paused` subagents resume from saved context; `queued` subagents are already waiting for capacity.
- Multiple targets are rejected because one global `message` must not broadcast to several subagents.

## `action: "steer"`
Send a non-empty `message` to one subagent by `id` (preferred) or a single-item `ids` array.
- A running subagent receives the message through its live handle.
- Optional `pause: true` requests a safe-boundary pause after steering a running subagent.
- `pause` only matters while the target is running.
- A non-active subagent (`paused`, `queued`, or terminal) automatically resumes with the message; `pause` is ignored for that target.
- Multiple targets are rejected because one global `message` must not broadcast to several subagents.

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
