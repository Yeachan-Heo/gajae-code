# resolve

> Finalizes a queued preview action by applying or discarding it.

## Source
- Entry: `packages/coding-agent/src/tools/resolve.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/resolve.md`
- Key collaborators:
  - `docs/resolve-tool-runtime.md` — preview/apply runtime reference
  - `packages/coding-agent/src/extensibility/custom-tools/loader.ts` — forwards custom pending actions into the queue
  - `packages/coding-agent/src/tools/ast-edit.ts` — built-in preview producer example
  - `packages/coding-agent/src/session/agent-session.ts` — tool-choice queue and invoker access

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"apply" | "discard"` | Yes | Whether to commit or reject the queued preview. |
| `reason` | `string` | Yes | Required explanation passed through to the queued callback. |
| `extra` | `Record<string, unknown>` | No | Free-form metadata passed to the queued action's `apply(reason, extra)` / `reject(reason, extra)` callback alongside `reason`. |

## Outputs
- Single-shot result.
- `execute()` returns whatever the queued invoker returns, with `details` wrapped/augmented to include:
  - `action`
  - `reason`
  - `sourceToolName?`
  - `label?`
  - `sourceResultDetails?` — original `result.details` from the apply/reject callback when present
- If `discard` has no custom reject callback, the default success payload is `Discarded: <label>. Reason: <reason>`.
- The TUI renderer is inline and merges call+result into one block.

## Flow
1. Preview-producing code calls `queueResolveHandler(...)` with a label, source tool name, and `apply(reason)` callback, plus optional `reject(reason)`.
2. `queueResolveHandler(...)` asks the session for a forced `resolve` tool choice and pushes it into the tool-choice queue with `pushOnce(...)`.
3. The queued entry is marked `now: true`; if the model rejects that forced tool choice, `onRejected` returns `requeue`, so the reminder comes back.
4. `queueResolveHandler(...)` also injects a `resolve-reminder` steering message: `This is a preview. Call the resolve tool to apply or discard these changes.`
5. When `resolve.execute()` runs, it wraps the call in `untilAborted(...)` and fetches the current queue invoker with `session.peekQueueInvoker()`.
6. If no invoker exists, it throws `ToolError("No pending action to resolve. Nothing to apply or discard.")`.
7. Otherwise it invokes the queued callback with `{ action, reason }`.
8. For `apply`, it always executes the producer's `apply(reason)` callback.
9. For `discard`, it executes `reject(reason)` when provided; if that callback is absent or returns `undefined`, `resolve` fabricates the default discard message.
10. Before returning, it merges resolve metadata into `result.details` so renderer/UI code can show the action, label, and originating tool.

## Modes / Variants
- `apply`: runs the queued `apply(reason)` callback and returns its content.
- `discard` with reject callback: runs `reject(reason)` and returns that callback's content.
- `discard` without reject callback: returns the built-in `Discarded: ...` text payload.

## Side Effects
- Session state
  - Consumes the current pending preview through the session tool-choice queue; there is no separate pending-action stack.
  - Adds a `resolve-reminder` steering message when a preview is queued.
- User-visible prompts / interactive UI
  - No direct prompt. The visible effect depends on the preview-producing tool and the resolve renderer.
- Background work / cancellation
  - `untilAborted(...)` lets abort signals interrupt resolution before invoking the callback completes.

## Limits & Caps
- Hidden tool: not discoverable in the normal tool index (`packages/coding-agent/src/tools/resolve.ts`, `packages/coding-agent/src/session/agent-session.ts`).
- Exactly one active queue invoker is consulted per call via `session.peekQueueInvoker()`.
- There is no independent queue depth cap in this tool; ordering follows the shared tool-choice queue (`docs/resolve-tool-runtime.md`).

## Errors
- No pending preview: throws `ToolError("No pending action to resolve. Nothing to apply or discard.")`.
- Any exception from the queued `apply` / `reject` callback propagates through `resolve`.
- Aborts during `untilAborted(...)` surface as the underlying abort error from the utility.

## Notes
- `reason` is informational; `resolve` passes it through but does not interpret it.
- `queueResolveHandler(...)` is the canonical built-in integration point; custom tools use `pushPendingAction(...)`, which the loader forwards into the same mechanism.
- The tool only works because another tool already staged a preview and forced a one-shot `resolve` choice.
- `sourceResultDetails` is added only when the apply/reject callback returned a non-null `details` field; custom pending-action `details` are not forwarded automatically by the loader.
