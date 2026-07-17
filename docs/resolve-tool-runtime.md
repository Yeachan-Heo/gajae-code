# Resolve tool runtime internals

This document explains how preview/apply workflows are modeled in coding-agent and how built-in or custom tools can participate via the tool-choice queue and `pushPendingAction`.

## Scope and key files

- [`src/tools/resolve.ts`](../packages/coding-agent/src/tools/resolve.ts)
- [`src/tools/ast-edit.ts`](../packages/coding-agent/src/tools/ast-edit.ts)
- [`src/extensibility/custom-tools/types.ts`](../packages/coding-agent/src/extensibility/custom-tools/types.ts)
- [`src/extensibility/custom-tools/loader.ts`](../packages/coding-agent/src/extensibility/custom-tools/loader.ts)
- [`src/sdk/session.ts`](../packages/coding-agent/src/sdk/session.ts)

## What `resolve` does

`resolve` is a hidden tool that finalizes a pending preview action.

- `action: "apply"` executes the queued action's `apply(reason)` callback and returns that result with resolve metadata.
- `action: "discard"` invokes `reject(reason)` if provided; otherwise returns `Discarded: <label>. Reason: <reason>`.

If no pending action exists, `resolve` fails with:

- `No pending action to resolve. Nothing to apply or discard.`

## Pending actions use the tool-choice queue

Preview producers call `queueResolveHandler(...)`, which pushes a one-shot forced `resolve` directive onto the session tool-choice queue and adds a `resolve-reminder` steering message.

Runtime behavior:

- the queued handler owns the pending `apply`/`reject` callbacks,
- `resolve` looks up the current queue invoker with `session.peekQueueInvoker()`,
- if the model rejects the forced tool choice, the queue directive is requeued,
- `resolve` does not maintain a separate pending-action stack.

Multiple pending previews therefore follow the active tool-choice queue ordering, not an independent pending-action store.

## Built-in producer example (`ast_edit`)

`ast_edit` previews structural replacements first. When the preview has replacements and is not applied yet, it queues a resolve handler that contains:

- label (human-readable summary)
- `sourceToolName` (`ast_edit`)
- `apply(reason: string)` callback that reruns AST edit with `dryRun: false`

`resolve(action="apply", reason="...")` passes `reason` into this callback.

## Custom tools: `pushPendingAction`

Custom tools can register resolve-compatible pending actions through `CustomToolAPI.pushPendingAction(...)`. The custom tool loader forwards these actions to `queueResolveHandler(...)` when that hook is available.

`CustomToolPendingAction`:

- `label: string` (required)
- `apply(reason: string): Promise<AgentToolResult<unknown>>` (required) — invoked on apply; `reason` is the string passed to `resolve`
- `reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>` (optional) — invoked on discard; return value replaces the default "Discarded" message if provided
- `details?: unknown` exists on the public custom-tool type but is not currently forwarded by the loader into resolve metadata
- `sourceToolName?: string` (optional, defaults to `"custom_tool"`)

### Minimal usage example

```ts
import type { CustomToolFactory } from "@gajae-code/coding-agent";

const factory: CustomToolFactory = (pi) => ({
  name: "batch_rename_preview",
  label: "Batch Rename Preview",
  description: "Previews renames and defers commit to resolve",
  parameters: pi.zod.object({
    files: pi.zod.array(pi.zod.string()),
  }),

  async execute(_toolCallId, params) {
    const previewSummary = `Prepared rename plan for ${params.files.length} files`;

    pi.pushPendingAction({
      label: `Batch rename: ${params.files.length} files`,
      sourceToolName: "batch_rename_preview",
      apply: async (reason) => {
        // apply writes here
        return {
          content: [
            { type: "text", text: `Applied batch rename. Reason: ${reason}` },
          ],
        };
      },
      reject: async (reason) => {
        // optional: cleanup or notify on discard
        return {
          content: [
            { type: "text", text: `Discarded batch rename. Reason: ${reason}` },
          ],
        };
      },
    });

    return {
      content: [
        {
          type: "text",
          text: `${previewSummary}. Call resolve to apply or discard.`,
        },
      ],
    };
  },
});

export default factory;
```

## Runtime availability and failures

`pushPendingAction` is wired by the custom tool loader through the active session's resolve queue hook.

If the runtime did not provide the resolve queue hook, `pushPendingAction` throws:

- `Pending action store unavailable for custom tools in this runtime.`

## Tool-choice behavior

When `queueResolveHandler(...)` registers a preview, the agent runtime forces a one-shot `resolve` tool choice so pending previews are explicitly finalized before normal tool flow continues.

## Developer guidance

- Use pending actions only for destructive or high-impact operations that should support explicit apply/discard.
- Keep `label` concise and specific; it is shown in resolve renderer output.
- Ensure `apply(reason)` is deterministic and idempotent enough for one-shot execution; `reason` is informational and should not change behavior.
- Implement `reject(reason)` when the discard needs cleanup (temp state, locks, notifications); omit it for stateless previews where the default message suffices.
- If your tool can stage multiple previews, remember they are mediated by the tool-choice queue rather than a separate pending-action stack.
