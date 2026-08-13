# python

> Execute Python in the persistent autoresearch mission kernel.

> **Notice:** this tool is only usable inside an `autoresearch` mission. For ordinary one-off code execution use [`eval`](./eval.md), which runs in a session-scoped kernel. Both tools drive the same Python kernel implementation; they differ in who owns the kernel and how long it lives.

## Source

- Entry: `packages/coding-agent/src/autoresearch/python-tool.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/python.md`
- Registration: `packages/coding-agent/src/tools/descriptors.ts` (`loadMode: "discoverable"`)
- Key collaborators:
  - `packages/coding-agent/src/autoresearch/session.ts` — mission-bound construction, notebook + artifacts dir
  - `packages/coding-agent/src/gjc-runtime/autoresearch-runtime.ts` — mission resolution (`autoresearchRead`)
  - `packages/coding-agent/src/eval/py/executor.ts` — kernel session retention and `disposeKernelSessionsByOwner`
  - `packages/coding-agent/src/rlm/notebook.ts` — notebook cell recording
  - `docs/python-repl.md` — Python kernel/gateway internals

## Availability

Registered at construction as a **discoverable** builtin with `defaultInactive: true`. It is therefore present in the registry but **not** in the active tool set for a normal session, and is activated on demand through the tool-discovery path (`search_tool_bm25` → `activateDiscoveredTools`).

Activation replaces the active set, so callers must pass the full merged list of tool names. `setActiveToolsByName` silently drops names it does not recognize, which is why the tool is registered at construction rather than injected later.

## Inputs

| Field | Type | Notes |
| :--- | :--- | :--- |
| `action` | `"execute" \| "clear"` | Optional; defaults to `"execute"`. |
| `code` | `string` | Required for `execute`; ignored for `clear`. |

There is deliberately **no** separate teardown tool. Clearing the kernel is an action on this same tool.

## Mission resolution and fail-closed behavior

The active mission is resolved **on every call** from `.gjc/_session-{sessionid}/autoresearch/`, not cached at construction. Two outcomes refuse the call:

- **No mission** — returns an error result naming `gjc autoresearch` as the way to start one.
- **Unreadable or corrupt mission state** — returns the same error with the underlying reason appended.

In both cases no kernel is started. The tool never falls back to a session-scoped or ad-hoc kernel, so a refusal always means the mission itself needs attention.

## Kernel ownership and teardown

The kernel owner id is `autoresearch:<mission-id>`, deliberately distinct from the session's eval kernel owner so the two never alias and a mission kernel is never reaped as collateral of eval cleanup.

Every owner the tool has touched is disposed on:

- the `clear` action,
- graceful session dispose,
- signal exit (Ctrl-C).

`disposeKernelSessionsByOwner` is idempotent, so `clear` followed by session exit is not a double free. The signal path drains **both** tool-cleanup registries, because the SDK binds a tool's `registerSessionCleanup` to the transition registry rather than the session one — draining only the latter orphaned the subprocess on interrupt.

## Notebook recording

Each `execute` is appended as a cell to the mission notebook under the session autoresearch runs directory, which is what lets the synthesized mission report replay the analysis. `clear` records no cell.

## Related

- [`eval`](./eval.md) — session-scoped Python/JavaScript execution
- `docs/python-repl.md` — kernel lifecycle, wire protocol, output capture
