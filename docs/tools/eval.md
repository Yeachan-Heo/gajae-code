# eval

> Execute Python or JavaScript code in persistent cell-based runtimes.

> **Notice:** Do not shell out to `python -c`/`python -e`, `bun -e`, or `node -e` via the `bash` tool for ad-hoc code execution. Use this tool instead — it gives you persistent state across cells, structured `display()` output, image/JSON capture, and proper cancellation/timeout handling that one-shot `-e`/`-c` invocations cannot provide.

> **Not to be confused with [`python`](./python.md).** `eval` runs in a **session-scoped** kernel and is the general-purpose choice. The `python` tool is a session-owned persistent REPL with its own `python:<session-id>` owner and an append-only JSONL transcript; it requires no active `autoresearch` mission. Both drive the same underlying Python kernel implementation — see [Kernel ownership](../python-repl.md#kernel-ownership).

## Source
- Entry: `packages/coding-agent/src/tools/eval.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/eval.md`
- Key collaborators:
  - `packages/coding-agent/src/eval/backend.ts` — backend execution contract
  - `packages/coding-agent/src/eval/js/index.ts` — JS backend adapter
  - `packages/coding-agent/src/eval/js/executor.ts` — JS execution + output sink
  - `packages/coding-agent/src/eval/js/context-manager.ts` — persistent JS worker contexts, tool bridge
  - `packages/coding-agent/src/eval/js/quickjs/runtime.ts` — QuickJS sandbox: limits, host bridge, final-value capture
  - `packages/coding-agent/src/eval/js/quickjs/prelude.txt` — JS global helpers inside the sandbox
  - `packages/coding-agent/src/eval/py/index.ts` — Python backend adapter
  - `packages/coding-agent/src/eval/py/executor.ts` — kernel session retention, reset, cleanup
  - `packages/coding-agent/src/eval/py/kernel.ts` — runner subprocess lifecycle, NDJSON framing, interrupt/shutdown
  - `packages/coding-agent/src/eval/py/runner.py` — NDJSON runner executed by the kernel subprocess
  - `packages/coding-agent/src/eval/py/display.ts` — MIME bundle to text/structured output mapping
  - `packages/coding-agent/src/eval/py/prelude.py` — Python helper functions and status events
  - `packages/coding-agent/src/session/streaming-output.ts` — truncation, artifacts, streamed chunks
  - `docs/python-repl.md` — Python runner and kernel internals

## Invocation lifetime

Local eval captures its working directory, session file, kernel namespace and existing owner identifier before backend availability checks. Its complete invocation is registered with session cleanup before asynchronous preflight, and remains tracked through output finalization. Direct SDK Python likewise captures context and registers its invocation before awaited `user_python` hooks. Cancellation or disposal is checked again before allocating output artifacts or dispatching backend execution.

Signal teardown fences new eval admission, aborts active invocation controllers and joins their actual futures within the existing bounded caller deadline. Unsettled work remains tracked and is reported rather than treated as physically stopped. A held hook or availability check cannot be forcibly interrupted merely by aborting its controller. This invocation boundary does not replace string kernel-owner identity, repair same-name owner reuse, or grant transcript/audit filesystem authority.

## Inputs

Tool parameters are a JSON object with a single `cells` field — an ordered array of cell objects. Each cell is a structured record; there is no `*** Cell` header parsing, no language sniffing, and no implicit single-cell fallback. Cells run in array order; state persists within each language across cells and across tool calls.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cells` | `EvalCellInput[]` | Yes | Cells executed in order. At least one cell is required (`.min(1)`). |

Each `EvalCellInput` (from `evalCellSchema` in `packages/coding-agent/src/tools/eval.ts`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `language` | `"py" \| "js"` | Yes | Backend selector. `"py"` maps to the persistent Python subprocess runner (`python` backend); `"js"` maps to the persistent JavaScript (QuickJS) sandbox. |
| `code` | `string` | Yes | Cell body, verbatim. JSON-encoded — embed newlines, quotes, and indentation directly; no fences, no headers. |
| `title` | `string` | No | Short label rendered in the transcript (e.g. `"imports"`, `"load config"`). |
| `timeout` | `integer` | No | Per-cell timeout in seconds, clamped to `1..600`. Defaults to 30 when omitted. |
| `reset` | `boolean` | No | Wipe this cell's language kernel before running. Reset is per-language: a `py` cell's reset does not touch the JS sandbox and vice versa. Defaults to `false`. |

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
- SDK tool contexts propagate allocation refusal before backend execution; they do not convert it into an empty successful allocation. Disposal during allocation remains subject to the existing execution-continuation check.
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

- `language: "py"` → Python (subprocess runner) backend
- `language: "js"` → JavaScript QuickJS sandbox backend

If the requested backend is disabled or unavailable, the tool throws `ToolError` for that cell. The caller chooses; the tool does not silently substitute.

### JavaScript runtime (QuickJS sandbox)

JavaScript cells have exactly one runtime: a QuickJS (wasm) sandbox, implemented in `packages/coding-agent/src/eval/js/quickjs/runtime.ts` and `packages/coding-agent/src/eval/js/quickjs/prelude.txt` on `quickjs-emscripten-core` with the `@jitl/quickjs-wasmfile-release-sync` variant. There is no Bun/Node execution path and no setting that selects one; `eval.js` only turns the backend on or off.

- One QuickJS context per session, keyed by `js:${sessionId}` in the `sessions` map of `context-manager.ts`. It lives inside a dedicated Bun Worker (`worker-entry.ts` → `worker-core.ts`) so a wedged cell can still be killed by terminating the thread.
- `reset: true` calls `resetVmContext(sessionKey)` before the cell executes; per-session runs are serialized with `runQueued()`.
- `wrapCode()` (`shared/rewrite-imports.ts`) strips TypeScript syntax, wraps cells that use top-level `await`/`return` in an async IIFE, and rewrites the final expression (or top-level `return`) into a `__gjc_set_final_expr__` call. The final value is adopted like `await` (thenables are followed once) and then displayed.
- Static `import ... from ...` and `import()` are rewritten to `__gjc_import__`, which throws `import of "<specifier>" is not available in the QuickJS sandbox`. Native `import()` built at runtime (through `eval`/`Function`) rejects because QuickJS has no module loader.
- The context has only QuickJS intrinsics (JSON, Math, Date, Promise, Map/Set, typed arrays, regex, ...) plus the prelude globals. There is no `fetch`, `Bun`, `process`, `require`, `Buffer`, `fs`, environment, `setInterval`, or module loader.
- Prelude globals:
  - `display`, `print`, `console.{log,info,warn,error,debug}` (a pure subset of `util.inspect` formatting)
  - `tool.<name>(args)` and `output(...ids)`; `output()` reads `agent://<id>` through `tool.read`
  - `read(path, { offset, limit })` and `write(path, content)`, thin wrappers over `tool.read({ path: "<path>:raw" })` (line windows cut in the sandbox) and `tool.write`; `write` accepts string content only
  - `sort`, `uniq`, `counter`: the shared host text helpers (`shared/helpers.ts`), called with plain data only
  - `sleep(ms)`, `setTimeout(fn, ms, ...args)`, `clearTimeout(id)`: timers ride on the host sleep and end with the cell, so a timer that has not fired when the cell finishes never runs
  - `append`, `tree`, `diff`, `env` are defined but throw an error that names the `tool.*` replacement
- `tool.<name>(args)` is the only way out. Calls take the worker → host `tool-call` frame and run through `callSessionTool()` with the session's permission, approval, and redaction guards, so they appear as normal tool calls and denials surface as catchable errors in the cell. A tool error the cell rethrows unchanged fails the cell with the original host error, so designed-error provenance survives.
- Values cross the boundary as JSON text, parsed on each side by intrinsics captured before user code runs. The raw host bridge is only reachable from the prelude closure, and `__gjc_set_final_expr__` / `__gjc_import__` are non-writable, non-configurable globals. Guest prototype or `JSON` tampering cannot redirect tool calls or reach host objects, and host error stacks are not copied into the guest.
- `display(value)` behavior:
  - plain objects/arrays become JSON outputs
  - `{ type: "image", data, mimeType }` becomes an image output (`data`: base64 string, `Uint8Array`/typed array, or `ArrayBuffer`)
  - scalars, and values that cannot be serialized (cycles), become text
- Limits: a 256 MiB guest heap (`out of memory` is a cell error) and a 512 KiB guest stack (`stack overflow` is a cell error). The cell timeout is enforced in the worker by an interrupt handler (synchronous loops, microtask loops) and a wait timer (pending tool calls, `sleep`). A timed-out cell reports `Command timed out` with `cancelled: true`, and the context and its bindings survive. The host timeout only kills the worker 2s after the cell deadline, as a backstop.
- A cell that awaits a promise with no tool call or timer in flight fails right away instead of waiting for the timeout.
- The worker's `close` frame disposes the QuickJS context and runtime; worker termination (reset, abort, owner disposal) frees them with the thread.

### Python runtime

Implemented in `packages/coding-agent/src/eval/py/executor.ts`, `packages/coding-agent/src/eval/py/kernel.ts`, and `packages/coding-agent/src/eval/py/prelude.py`. See `docs/python-repl.md` for runner and kernel details.

- Default mode is retained `session` kernels keyed by `python:${sessionId}`
- Optional `python.kernelMode = "per-call"` creates a fresh kernel for each cell and shuts it down afterward
- `reset: true` disposes the retained kernel for that session before the cell runs; later Python cells in the same tool call reuse the fresh kernel
- Startup path:
  - availability check
  - spawn `python -u runner.py` as its own process group
  - initialize cwd / env / `sys.path`
  - execute `PYTHON_PRELUDE`
- The runner compiles cells with `PyCF_ALLOW_TOP_LEVEL_AWAIT` on a persistent event loop, so top-level `await` works; the prompt warns not to use `asyncio.run(...)`
- The Python prelude defines synchronous helpers with the same surface as JS. When the host tool bridge starts, `tool.<name>(args)` is also available in Python (via the `PI_TOOL_BRIDGE_*` environment variables)
- `display(value)` turns plain dict/list/tuple values into an `application/json` + `text/plain` bundle; objects with `_repr_*_` methods keep their rich MIME bundles
- Runner `display` / `result` frames map through `renderKernelDisplay()` (`packages/coding-agent/src/eval/py/display.ts`) to:
  - `application/x-gjc-status` → status event (no text)
  - `image/png` / `image/jpeg` → image output
  - `application/json` → JSON output
  - text, by precedence: `text/markdown` (markdown output) > `text/plain` > `text/html` converted to markdown with `htmlToBasicMarkdown()`
- Interactive stdin is not supported: the runner does not forward `input()` prompts, so a cell that calls `input()` blocks until it is cancelled or times out

### Multi-language call behavior

A single tool call can mix Python and JS cells. Persistence is per language runtime:

- `reset: true` on a Python cell does not touch JS state
- `reset: true` on a JS cell does not touch Python state
- each backend keeps its own retained session keyed from the same session-derived ID

## Side Effects

- Filesystem
  - Python prelude helpers can read, write, append, diff, and traverse files under the session cwd or absolute paths.
  - JS cells have no filesystem access of their own; `read`/`write` and every other file effect go through `tool.*` calls.
  - Output may spill to an artifact file via `OutputSink`.
- Network
  - Python backend speaks NDJSON to a local `python3` subprocess over stdin/stdout (no network).
  - JS cells have no `fetch`; network I/O happens only inside the tools they call through `tool.<name>()`.
- Subprocesses / native bindings
  - Python availability check runs `<python> -c ...`.
  - Python backend spawns one `python -u runner.py` subprocess per kernel; cancellation sends `SIGINT`. Details in `docs/python-repl.md`.
- Session state
  - `session.assertEvalExecutionAllowed?.()` can block execution.
  - `session.trackEvalExecution?.(...)` can register cancellable eval work.
  - `session.getSessionFile?.()` and `session.getEvalKernelOwnerId?.()` influence kernel reuse and artifact lookup.
  - JS QuickJS contexts persist in the `sessions` map of `context-manager.ts` across eval calls until reset/disposal.
  - Python retained kernels persist in the executor's `sessions` map until reset, owner cleanup (`disposeKernelSessionsByOwner()`), or process shutdown (`disposeAllKernelSessions()`). There is no idle eviction or session cap.
- User-visible prompts / interactive UI
  - none; stdin requests are rejected programmatically
- Background work / cancellation
  - Python kernels have no heartbeat or idle timers. A dead retained kernel is detected with `isAlive()` when the next cell runs and is replaced.
  - Cancellation interrupts a running Python kernel and aborts JS promise waits.

## Limits & Caps

- Per-cell timeout default: 30s (applied when `timeout` is omitted in `EvalTool.execute()`; clamped through `TOOL_TIMEOUTS.eval.default` in `packages/coding-agent/src/tools/tool-timeouts.ts`)
- Schema-level `timeout` range: integer `1..600` seconds (enforced by Zod on the cell schema)
- Timeout clamp at runtime: 1s minimum, 600s maximum (`TOOL_TIMEOUTS.eval` in `packages/coding-agent/src/tools/tool-timeouts.ts`)
- Transcript code/output preview: 10 lines by default (`EVAL_DEFAULT_PREVIEW_LINES` in `packages/coding-agent/src/tools/eval.ts`)
- Output truncation window: 50KB default (`DEFAULT_MAX_BYTES` in `packages/coding-agent/src/session/streaming-output.ts`)
- Output line cap inside truncation helpers: 3000 lines (`DEFAULT_MAX_LINES` in `packages/coding-agent/src/session/streaming-output.ts`)
- Streaming tail buffer for live updates: `DEFAULT_MAX_BYTES * 2` = 100KB (`packages/coding-agent/src/tools/eval.ts`)
- Python kernel startup budget: 10s shared by the init script and prelude (`STARTUP_TIMEOUT_MS` in `packages/coding-agent/src/eval/py/kernel.ts`)
- Python interrupt escalation: if the runner has not finished 5s after `SIGINT`, the kernel is shut down and the cell is marked as kernel-killed (`INTERRUPT_ESCALATION_MS` in `packages/coding-agent/src/eval/py/kernel.ts`)
- Python shutdown: `{"type":"exit"}`, then `SIGTERM`, then `SIGKILL`, waiting 1s per step by default (`SHUTDOWN_GRACE_MS` in `packages/coding-agent/src/eval/py/kernel.ts`)
- Python dead-kernel recovery: a retained kernel found dead before a cell runs is replaced; a non-cancellation failure that leaves it dead is replaced and the cell is retried once (`executeOnSession()` in `packages/coding-agent/src/eval/py/executor.ts`)
- Retained Python kernels have no idle timeout, session cap, or heartbeat

## Errors

- Zod validation rejects malformed `cells` arrays before `execute()` runs (missing `language`/`code`, out-of-range `timeout`, empty `cells`).
- Missing session without proxy executor throws `ToolError("Eval tool requires a session when not using proxy executor")`.
- Disabled/unavailable backends throw `ToolError` from `resolveBackend()`:
  - `eval.py = false` and a `py` cell is requested
  - `eval.js = false` and a `js` cell is requested
  - Python kernel unavailable and a `py` cell is requested
- JS runtime exceptions are converted into text output plus `exitCode: 1`; cancellations return `cancelled: true` and may append `Command timed out`.
- Python execution errors from the kernel become text output and `exitCode: 1`; later cells are skipped.
- Python timeouts annotate the output: `eval cell timed out after <n>s; kernel interrupted but remains running. ...`, or, when the kernel ignored the interrupt and was killed, a notice that it will be recreated on the next call (`formatKernelTimeoutAnnotation()` in `packages/coding-agent/src/eval/py/executor.ts`).
- Cancellation is returned, not thrown, once backend execution has started. The tool formats it as a cell failure and sets `details.isError = true`.
- If output truncates, the tool still succeeds; truncation is surfaced through `details.meta` and artifact-backed full output when available.

## Notes

- Backend selection is now strictly explicit per cell: `language` must be `"py"` or `"js"`. The previous `*** Cell` header parser, the `eval.lark` constrained grammar, and the sniffer-based fallback have all been removed.
- `EvalTool.customFormat` no longer exists. Tool calls flow through the standard JSON schema; there is no Lark-constrained sampling path.
- `tool.<name>()` exists in JS, and in Python when the host tool bridge starts. Python `output(...)` also goes through the bridge; the other Python prelude helpers work on the filesystem directly.
- JS `read(path)` goes through `tool.read`, so internal URIs and URLs follow the read tool's own rules and permissions.
- Python helper `output(...)` reads each id through the tool bridge, as the JS helper does, with `tool.read({"path": "agent://<id>:raw"})`, so it no longer depends on `PI_ARTIFACTS_DIR` / `PI_SESSION_FILE`. `offset`/`limit`, `query`, and `format` (`raw`, `stripped`, `json`) are applied in Python to the full raw output. It raises `RuntimeError` when the tool bridge is unavailable.
- `display()` can produce text and structured outputs from the same value; the renderer prefers markdown over `text/plain` when both exist.
- JS static imports are rewritten only at top level, and the rewritten import throws in the sandbox. Nested imports stay invalid and surface normal JS syntax/runtime errors.
- `EvalTool` is `concurrency = "exclusive"`, so eval calls do not overlap within a session.
- The tool description shown to the model is templated by backend availability (`getEvalToolDescription()`); if Python is unavailable, the prompt omits Python-specific instructions.
