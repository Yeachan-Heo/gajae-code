# checkpoint

> Mark the current top-level conversation state so later `rewind` can collapse exploratory context into a report.

## Source
- Entry: `packages/coding-agent/src/tools/checkpoint.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/checkpoint.md`
- Key collaborators:
  - `packages/coding-agent/src/session/agent-session.ts` — captures the active checkpoint after tool success.
  - `packages/coding-agent/src/session/session-manager.ts` — persists the normal session entry stream; not the active checkpoint marker.
  - `packages/coding-agent/src/tools/descriptors.ts` — defines the discoverable descriptor and gates it behind `checkpoint.enabled`.
  - `packages/coding-agent/src/config/settings-schema.ts` — defines the disabled-by-default feature flag.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `goal` | `string` | Yes | Investigation goal. Required by the schema and echoed in the tool result. |

## Outputs
The tool returns a single text result plus structured details:

- text body:
  - `Checkpoint created.`
  - `Goal: <goal>`
  - `Run your investigation, then call rewind with a concise report.`
- `details`:
  - `goal: string`
  - `startedAt: string` — ISO timestamp created inside `CheckpointTool.execute()`

No checkpoint ID, artifact URI, job handle, file path, or restore token is returned.

## Flow
1. `CheckpointTool.createIf()` in `packages/coding-agent/src/tools/checkpoint.ts` returns `null` for subagents by checking `session.taskDepth`; only top-level sessions can see the tool.
2. `CheckpointTool.execute()` rejects subagent calls again with `ToolError("Checkpoint not available in subagents.")`.
3. It rejects nested checkpoints with `ToolError("Checkpoint already active.")` when `session.getCheckpointState?.()` is already set.
4. It creates `startedAt = new Date().toISOString()` and returns a normal `toolResult()` payload. The tool itself does not persist anything.
5. On the later `tool_execution_end` event, `AgentSession` in `packages/coding-agent/src/session/agent-session.ts` detects successful `checkpoint` execution and captures three in-memory fields:
   - `checkpointMessageCount` — current `agent.state.messages.length`, after the checkpoint tool result has already been appended
   - `checkpointEntryId` — `sessionManager.getLeafId()`, i.e. the current leaf entry ID in the session tree at checkpoint time (`null` when the tree has no leaf)
   - `startedAt` — copied from tool details or regenerated
6. `AgentSession` stores that object in its private `#checkpointState` field and clears `#pendingRewindReport`.

## Side Effects
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Sets `AgentSession.#checkpointState` in memory.
  - Records the checkpoint boundary as a message count plus a session entry ID.
  - Enables the later yield guard: if a checkpoint is active and no rewind report is pending, `#enforceRewindBeforeYield()` injects a developer-role warning and schedules another turn.
- User-visible prompts / interactive UI
  - The tool result tells the model to call `rewind` after the investigation.
  - If the agent tries to `yield` first, `AgentSession` injects:

```text
<system-warning>
You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.
</system-warning>
```

## Limits & Caps
- Availability is gated by `checkpoint.enabled`, default `false`, in `packages/coding-agent/src/config/settings-schema.ts`.
- The tool is defined as a discoverable descriptor in `packages/coding-agent/src/tools/descriptors.ts`, which also gates availability on `checkpoint.enabled` and on `session.taskDepth === 0`.
- Only one active checkpoint is allowed per top-level session.
- Checkpoint state is not persisted as a dedicated session entry. If the process exits, a resumed session can reload the conversation history, but not the live `#checkpointState` guard.
- Session persistence still applies to the ordinary checkpoint tool call message. Global session persistence truncation is `MAX_PERSIST_CHARS = 500_000` in `packages/coding-agent/src/session/session-manager.ts`.

## Errors
- `ToolError("Checkpoint not available in subagents.")` — thrown for subagent sessions.
- `ToolError("Checkpoint already active.")` — thrown when a prior checkpoint has not been rewound or cleared.
- The tool body has no local `try/catch`; unexpected exceptions propagate.

## Notes
- Despite the summary string `Create a git-based checkpoint to save and restore session state`, the implementation does not call git and does not snapshot filesystem state.
- Captured state is conversation/session metadata only:
  - in-memory message count
  - session entry ID in the session tree
  - timestamp
- Not captured:
  - working tree contents
  - staged changes
  - artifacts
  - blob-store contents
  - SQLite history rows from `packages/coding-agent/src/session/history-storage.ts`
  - auth or agent records from `packages/coding-agent/src/session/agent-storage.ts`
- A pending rewind is applied on `turn_end` (`AgentSession` event handler: `if (event.type === "turn_end" && this.#pendingRewindReport)`), not when `rewind` returns. `rewind` only records the report; the context replacement runs at turn end.
- `#checkpointState` is cleared in exactly one place: the end of `#applyRewind`, once the rewind report has been branched and appended. There is no abort-driven clear — an aborted turn leaves `#checkpointState` set, so the `#enforceRewindBeforeYield()` guard still applies and the rewind must still be completed.
