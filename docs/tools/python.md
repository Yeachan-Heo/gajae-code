# python

> Execute Python in a persistent session-owned REPL with an append-only JSONL transcript.

> **Notice:** this tool is available without an active `autoresearch` mission. For multi-language or one-off code execution use [`eval`](./eval.md); both tools use the same Python execution stack but retain separate kernels.

## Source

- Entry: `packages/coding-agent/src/tools/python.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/python.md`
- Registration: `packages/coding-agent/src/tools/descriptors.ts` (`loadMode: "discoverable"`)
- Key collaborators:
  - `packages/coding-agent/src/gjc-runtime/python-transcript.ts` — runtime-owned append-only JSONL transcript recording
  - `packages/coding-agent/src/gjc-runtime/session-layout.ts` — session-rooted transcript and artifact paths
  - `packages/coding-agent/src/eval/py/executor.ts` — kernel session retention and `disposeKernelSessionsByOwner`
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

## Session resolution

Every call resolves the current GJC session id. `execute` and `clear` return an actionable error when no session id is available, because the kernel owner and session-rooted paths cannot be derived. No active `autoresearch` mission is required.

The REPL runs in the session cwd and retains variables, imports, and loaded data across `execute` calls for that session.

## Kernel ownership and teardown

The kernel owner id is `python:<session-id>`, deliberately distinct from the `eval` owner so the two never alias and cleanup remains scoped to the owning session.

The session's kernel is disposed on:

- the `clear` action,
- session cleanup, including a session identity transition,
- signal exit (Ctrl-C).

`gjc autoresearch clear` clears autoresearch state only; it does not dispose a Python kernel.

## Transcript recording

The runtime records one JSONL entry per `execute` at `$GJC_STATE_DIR/_session-{sessionid}/ipykernels/{datetime}-{kernelid}/transcript.jsonl`, containing `timestamp`, `code`, `output`, `exitCode`, `cancelled`, and `truncated`. `{kernelid}` is the executor identity captured when the kernel is acquired, so a real kernel replacement uses a new transcript directory. `clear` records no entry.

Display artifacts use the stable session-rooted directory `$GJC_STATE_DIR/_session-{sessionid}/ipykernels/artifacts`, rather than a per-kernel transcript directory.

## Related

- [`eval`](./eval.md) — session-scoped Python/JavaScript execution
- `docs/python-repl.md` — kernel lifecycle, wire protocol, output capture
