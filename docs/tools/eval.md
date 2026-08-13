# eval

> Execute Python or JavaScript code in persistent cell-based runtimes.

> **Notice:** Do not shell out to `python -c`/`python -e`, `bun -e`, or `node -e` via the `bash` tool for ad-hoc code execution. Use this tool instead — it gives you persistent state across cells, structured `display()` output, image/JSON capture, and proper cancellation/timeout handling that one-shot `-e`/`-c` invocations cannot provide.

> **Not to be confused with [`python`](./python.md).** `eval` runs in a **session-scoped** kernel and is the general-purpose choice. The `python` tool runs in a kernel owned by an active `autoresearch` mission and records every call as a notebook cell; it is unavailable outside a mission. Both drive the same underlying Python kernel implementation — see [Kernel ownership](../python-repl.md#kernel-ownership).

## Source
- Entry: `packages/coding-agent/src/tools/eval.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/eval.md`
- Key collaborators:
  - `packages/coding-agent/src/eval/backend.ts` — backend execution contract
  - `packages/coding-agent/src/eval/js/index.ts` — JS backend adapter
  - `packages/coding-agent/src/eval/js/executor.ts` — JS execution + output sink
  - `packages/coding-agent/src/eval/js/context-manager.ts` — persistent VM contexts, prelude, tool bridge
  - `packages/coding-agent/src/eval/js/prelude.txt` — JS global helpers
  - `packages/coding-agent/src/eval/py/index.ts` — Python backend adapter
  - `packages/coding-agent/src/eval/py/executor.ts` — kernel session retention, reset, cleanup
  - `packages/coding-agent/src/eval/py/kernel.ts` — Jupyter gateway/kernel protocol, display capture
  - `packages/coding-agent/src/eval/py/prelude.py` — Python helper functions and status events
  - `packages/coding-agent/src/session/streaming-output.ts` — truncation, artifacts, streamed chunks
  - `docs/python-repl.md` — Python kernel/gateway internals

## Inputs

Tool parameters are a JSON object with a single `cells` field — an ordered array of cell objects. Each cell is a structured record; there is no `*** Cell` header parsing, no language sniffing, and no implicit single-cell fallback. Cells run in array order; state persists within each language across cells and across tool calls.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cells` | `EvalCellInput[]` | Yes | Cells executed in order. At least one cell is required (`.min(1)`). |

Each `EvalCellInput` (from `evalCellSchema` in `packages/coding-agent/src/tools/eval.ts`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `language` | `"py" \| "js"` | Yes | Backend selector. `"py"` maps to the IPython/Jupyter kernel (`python` backend); `"js"` maps to the persistent JavaScript VM. |
| `code` | `string` | Yes | Cell body, verbatim. JSON-encoded — embed newlines, quotes, and indentation directly; no fences, no headers. |
| `title` | `string` | No | Short label rendered in the transcript (e.g. `"imports"`, `"load config"`). |
| `timeout` | `integer` | No | Per-cell timeout in seconds, clamped to `1..600`. Defaults to 30 when omitted. |
| `reset` | `boolean` | No | Wipe this cell's language kernel before running. Reset is per-language: a `py` cell's reset does not touch the JS VM and vice versa. Defaults to `false`. |

Minimal example matching the live schema:

```json
{
  "cells": [
    { "language": "py", "title": "imports", "timeout": 10, "code": "import json\nfrom pathlib import Path" },
    { "language": "py", "title": "load config", "code": "data = json.loads(read('package.json'))\ndisplay(data)" },
    { "language": "js", "title": "summary", "reset": true, "code": "const data = JSON.parse(await read('package.json'));\ndisplay(data);\nreturn data.name;" }
  ]
}
```

## Outputs

Final result from `EvalTool.execute()` is single-shot, but `onUpdate` streams partial text and `details` while cells run.

Returned shape:

- `content`: one text block containing combined cell output, or `(no text output)` / `(no output)` when only rich outputs exist.
- `details` (`EvalToolDetails` from `packages/coding-agent/src/eval/types.ts`):
  - `cells`: per-cell code, status (`pending`/`running`/`complete`/`error`), output, duration, exit code, status events, markdown flag
  - `language`: first backend used
  - `languages`: distinct backends used, in first-use order
  - `jsonOutputs`: structured values emitted via `display(...)`
  - `images`: image payloads emitted by Python rich display or JS `display({ type: "image", ... })`
  - `statusEvents`: aggregated helper/tool status events
  - `notice`: backend fallback notice (currently unused; reserved for future per-cell notices)
  - `meta`: truncation metadata
  - `isError`: set on cell failure or cancellation

Renderer behavior in `packages/coding-agent/src/tools/eval.ts`:

- call preview renders each cell's `code` with syntax highlighting based on its declared `language`
- result view renders each cell separately, including status, duration, and output
- markdown outputs are rendered with the Markdown component instead of plain text
- `jsonOutputs` render as a tree, collapsed or expanded depending on UI state
- timeout / truncation notices render as dim metadata lines
- images are carried in `details.images`; generic tool UI image handling renders them outside the text block

Side-channel artifacts:

- `session.allocateOutputArtifact?.("eval")` may allocate an `artifact://...` backing store for spilled output.
- Truncated output metadata points at that artifact when available.

## Flow

1. `EvalTool.execute()` in `packages/coding-agent/src/tools/eval.ts` receives `params.cells` already validated by the Zod schema — no string parsing step.
2. For each cell, `execute()` maps `cell.language` to an `EvalLanguage` (`"py"` → `"python"`, `"js"` → `"js"`) and calls `resolveBackend(session, language)`:
   - `python` is gated on `eval.py !== false` and `pythonBackend.isAvailable(session)`.
   - `js` is gated on `eval.js !== false`.
   - A disabled or unavailable requested backend throws `ToolError`; there is no auto-fallback or sniffing.
3. The tool allocates an `OutputSink`, a `TailBuffer`, per-cell result objects, and a `sessionAbortController`. `session.trackEvalExecution?.(...)` can wrap the whole run for external cancellation tracking.
4. Cells execute sequentially. For each cell, `execute()`:
   - clamps `(cell.timeout ?? 30) * 1000` ms through `clampTimeout("eval", ...)`
   - builds a combined abort signal from the tool signal, the timeout, and the session abort controller
   - marks the cell `running` and emits an update
   - calls the backend’s `execute()` with `cwd`, `sessionId`, `sessionFile`, `kernelOwnerId`, `deadlineMs`, `reset` (defaults to `false`), artifact info, and chunk callback
5. JS cells dispatch through `packages/coding-agent/src/eval/js/index.ts` into `executeJs()`; Python cells dispatch through `packages/coding-agent/src/eval/py/index.ts` into `executePython()`.
6. Backend text chunks stream into the shared `OutputSink`; rich outputs are accumulated separately as JSON, images, markdown markers, and status events.
7. After each cell:
   - text output is trimmed and stored on that cell result
   - multi-cell runs prefix text with `[i/n]` and the optional title
   - cancellations return early with `isError: true` and a cell-specific abort message
   - non-zero exit codes return early with `isError: true` and a message naming the failed cell
   - later cells are skipped after the first error, but earlier cell state persists in the underlying runtime
8. On success, the tool joins all cell outputs, synthesizes `(no text output)` or `(no output)` when needed, and attaches truncation metadata from `summarizeFinal()`.
9. The renderer uses `details.cells`, `details.jsonOutputs`, and `details.statusEvents` to build notebook-style output. `mergeCallAndResult = true` and `inline = true`, so call and result render together in the transcript.

## Modes / Variants

### Backend selection

Backend choice is **explicit per cell** — there is no auto-detection.

- `language: "py"` → Python (IPython/Jupyter) backend
- `language: "js"` → JavaScript VM backend

If the requested backend is disabled or unavailable, the tool throws `ToolError` for that cell. The caller chooses; the tool does not silently substitute.

### JavaScript runtime

Implemented in `packages/coding-agent/src/eval/js/context-manager.ts` and `packages/coding-agent/src/eval/js/prelude.txt`.

- Persistent `vm.Context` instances keyed by `js:${sessionId}` in `vmContexts`
- `reset: true` calls `resetVmContext(sessionKey)` before the cell executes
- Top-level `await` and bare `return` are supported by wrapping code in an async IIFE when `wrapCode()` sees `await` or `return`
- Top-level static `import ... from ...` and dynamic `import(...)` calls are routed through `rewriteImports()`, which sends them via `__gjc_import__` so the specifier resolves against the session cwd
- Module cache is busted for **local** imports between cells so edits to source files are picked up without restarting the runtime. `__gjc_import__` deletes `require.cache[absPath]` before re-importing whenever the original specifier is a filesystem path: relative (`./x`, `../x`, `.`, `..`), POSIX-absolute (`/...`), home-prefixed (`~/...`), or Windows drive-letter (`C:\...` / `C:/...`). Bare specifiers (`react`, `lodash/x`) and URL/scheme specifiers (`node:fs`, `file://...`, `https://...`) are left in cache so package identity stays stable across cells. The cache-bust only fires when the resolved target is an absolute path — unresolved bare-package fallbacks (`resolveImportSpecifier()` returning the original specifier) skip it.
- The prelude installs globals:
  - `display`, `print`
  - `read`, `write`, `append`, `sort`, `uniq`, `counter`, `diff`, `tree`, `env`, `output`
  - `tool.<name>(args)` proxy for arbitrary session tool calls
- JS helpers are async because they cross the VM/tool boundary
- `display(value)` behavior:
  - plain objects/arrays become JSON outputs
  - `{ type: "image", data, mimeType }` becomes an image output
  - scalars become text
- The VM exposes a restricted `process` subset plus `Buffer`, `fetch`, `Blob`, `File`, `Headers`, `Request`, `Response`, `fs`, `require`, and browser-style globals
- Per-session VM runs are serialized with `runQueued()`

### Python runtime

Implemented in `packages/coding-agent/src/eval/py/executor.ts`, `packages/coding-agent/src/eval/py/kernel.ts`, and `packages/coding-agent/src/eval/py/prelude.py`. See `docs/python-repl.md` for gateway and kernel details.

- Default mode is retained `session` kernels keyed by `python:${sessionId}`
- Optional `python.kernelMode = "per-call"` creates a fresh kernel for each cell and shuts it down afterward
- `reset: true` disposes the retained kernel for that session before the cell runs; later Python cells in the same tool call reuse the fresh kernel
- Startup path:
  - availability check
  - create/connect kernel
  - initialize cwd / env / `sys.path`
  - execute `PYTHON_PRELUDE`
- Python cells run inside IPython/Jupyter, so top-level `await` works; the prompt warns not to use `asyncio.run(...)`
- The Python prelude defines synchronous helpers with the same surface as JS (except `tool.<name>` exists only in JS)
- `display(value)` wraps dict/list/tuple values in `IPython.display.JSON`; rich display MIME bundles are preserved
- Kernel `display_data` / `execute_result` messages map to:
  - `application/x-gjc-status` → status event
  - `image/png` → image output
  - `application/json` → JSON output
  - `text/markdown` → markdown output
  - `text/plain` → text output
  - `text/html` → HTML converted to markdown with `htmlToBasicMarkdown()`
- Interactive stdin is rejected: `input_request` sends an empty reply, marks `stdinRequested`, and the executor returns exit code `1`

### Multi-language call behavior

A single tool call can mix Python and JS cells. Persistence is per language runtime:

- `reset: true` on a Python cell does not touch JS state
- `reset: true` on a JS cell does not touch Python state
- each backend keeps its own retained session keyed from the same session-derived ID

## Side Effects

- Filesystem
  - JS/Python prelude helpers can read, write, append, diff, and traverse files under the session cwd or absolute paths.
  - Output may spill to an artifact file via `OutputSink`.
- Network
  - Python backend speaks NDJSON to a local `python3` subprocess over stdin/stdout (no network).
  - JS runtime exposes `fetch` and `tool.<name>()`; those tools may perform additional network I/O.
- Subprocesses / native bindings
  - Python availability check runs `<python> -c ...`.
  - Python backend spawns one `python -u runner.py` subprocess per kernel; cancellation sends `SIGINT`. Details in `docs/python-repl.md`.
- Session state
  - `session.assertEvalExecutionAllowed?.()` can block execution.
  - `session.trackEvalExecution?.(...)` can register cancellable eval work.
  - `session.getSessionFile?.()` and `session.getEvalKernelOwnerId?.()` influence kernel reuse and artifact lookup.
  - JS VM contexts persist in `vmContexts` across eval calls until reset/disposal.
  - Python retained kernels persist in `kernelSessions` until reset, eviction, idle cleanup, or owner cleanup.
- User-visible prompts / interactive UI
  - none; stdin requests are rejected programmatically
- Background work / cancellation
  - Python retained kernels have heartbeat and idle cleanup timers.
  - Cancellation interrupts a running Python kernel and aborts JS promise waits.

## Limits & Caps

- Per-cell timeout default: 30s (applied when `timeout` is omitted in `EvalTool.execute()`; clamped through `TOOL_TIMEOUTS.eval.default` in `packages/coding-agent/src/tools/tool-timeouts.ts`)
- Schema-level `timeout` range: integer `1..600` seconds (enforced by Zod on the cell schema)
- Timeout clamp at runtime: 1s minimum, 600s maximum (`TOOL_TIMEOUTS.eval` in `packages/coding-agent/src/tools/tool-timeouts.ts`)
- Transcript code/output preview: 10 lines by default (`EVAL_DEFAULT_PREVIEW_LINES` in `packages/coding-agent/src/tools/eval.ts`)
- Output truncation window: 50KB default (`DEFAULT_MAX_BYTES` in `packages/coding-agent/src/session/streaming-output.ts`)
- Output line cap inside truncation helpers: 3000 lines (`DEFAULT_MAX_LINES` in `packages/coding-agent/src/session/streaming-output.ts`)
- Streaming tail buffer for live updates: `DEFAULT_MAX_BYTES * 2` = 100KB (`packages/coding-agent/src/tools/eval.ts`)
- Python retained kernel idle timeout: 5 minutes (`IDLE_TIMEOUT_MS` in `packages/coding-agent/src/eval/py/executor.ts`)
- Python retained kernel cap: 4 sessions (`MAX_KERNEL_SESSIONS` in `packages/coding-agent/src/eval/py/executor.ts`)
- Python retained kernel cleanup sweep: every 30s (`CLEANUP_INTERVAL_MS` in `packages/coding-agent/src/eval/py/executor.ts`)
- Python owner-cleanup shutdown wait: 2000ms (`OWNER_CLEANUP_KERNEL_SHUTDOWN_TIMEOUT_MS` in `packages/coding-agent/src/eval/py/executor.ts`)
- Python heartbeat interval: 5s (`ensureKernelHeartbeat()` in `packages/coding-agent/src/eval/py/executor.ts`)
- Python external gateway availability check timeout: 5s (`AbortSignal.timeout(5000)` in `packages/coding-agent/src/eval/py/kernel.ts`)
- Python auto-restart budget: one restart per retained session before hard failure (`restartCount > 1` in `packages/coding-agent/src/eval/py/executor.ts`)

## Errors

- Zod validation rejects malformed `cells` arrays before `execute()` runs (missing `language`/`code`, out-of-range `timeout`, empty `cells`).
- Missing session without proxy executor throws `ToolError("Eval tool requires a session when not using proxy executor")`.
- Disabled/unavailable backends throw `ToolError` from `resolveBackend()`:
  - `eval.py = false` and a `py` cell is requested
  - `eval.js = false` and a `js` cell is requested
  - Python kernel unavailable and a `py` cell is requested
- JS runtime exceptions are converted into text output plus `exitCode: 1`; cancellations return `cancelled: true` and may append `Command timed out`.
- Python execution errors from the kernel become text output and `exitCode: 1`; later cells are skipped.
- Python stdin requests are treated as errors with the message `Kernel requested stdin; interactive input is not supported.`
- Cancellation is returned, not thrown, once backend execution has started. The tool formats it as a cell failure and sets `details.isError = true`.
- If output truncates, the tool still succeeds; truncation is surfaced through `details.meta` and artifact-backed full output when available.

## Notes

- Backend selection is now strictly explicit per cell: `language` must be `"py"` or `"js"`. The previous `*** Cell` header parser, the `eval.lark` constrained grammar, and the sniffer-based fallback have all been removed.
- `EvalTool.customFormat` no longer exists. Tool calls flow through the standard JSON schema; there is no Lark-constrained sampling path.
- `tool.<name>()` exists only in JS. Python prelude helpers do not call back into the full tool registry.
- JS helper paths reject protocol URIs (`://`) in `resolvePath()`; the JS prelude is filesystem-only unless the code calls `tool.read(...)` or another tool explicitly.
- Python helper `output(...)` depends on `GJC_SESSION_FILE`; it fails outside a session-backed run.
- `display()` can produce text and structured outputs from the same value; the renderer prefers markdown over `text/plain` when both exist.
- JS static imports are rewritten only at top level. Nested imports stay invalid and surface normal JS syntax/runtime errors.
- `EvalTool` is `concurrency = "exclusive"`, so eval calls do not overlap within a session.
- The tool description shown to the model is templated by backend availability (`getEvalToolDescription()`); if Python is unavailable, the prompt omits Python-specific instructions.
