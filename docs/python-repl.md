# Eval Tool Python Backend

This document describes the Python execution stack in `packages/coding-agent`.
It covers tool behavior, runner lifecycle, environment handling, execution semantics, output rendering, supported magics, and operational failure modes.

## Scope and Key Files

- Tool surface: `src/tools/eval.ts`
- Session/per-call kernel orchestration: `src/eval/py/executor.ts`
- Subprocess kernel client: `src/eval/py/kernel.ts`
- Python wrapper / NDJSON server: `src/eval/py/runner.py`
- Prelude helpers loaded into every kernel: `src/eval/py/prelude.py`
- MIME bundle renderer (text + structured outputs): `src/eval/py/display.ts`
- Interactive-mode renderer for user-triggered Python runs: `src/modes/components/eval-execution.ts`
- Runtime/env filtering and Python resolution: `src/eval/py/runtime.ts`

## What eval's Python backend is

The `eval` tool executes one or more Python cells inside a long-lived `python3` subprocess that speaks NDJSON over stdin/stdout. No Jupyter, no kernel gateway, no extra pip dependencies — a vanilla Python 3.8+ interpreter is enough. Rich `display()` output (PIL, pandas, plotly, matplotlib figures) keeps working because the wrapper reimplements the MIME-bundle dispatch that IPython previously provided.

Tool params:

```ts
{
  cells: Array<{ code: string; title?: string }>;
  timeout?: number; // seconds, clamped to 1..600, default 30
  reset?: boolean; // reset selected runtime before the first cell only
}
```

The tool is `concurrency = "exclusive"` for a session, so calls do not overlap.

## Kernel lifecycle

Each kernel is a single Python subprocess: `python -u <runner.py>`. The bundled runner is materialized once per GJC process in a process-private temporary directory and file, then reused only by subsequent spawns within that process.

Kernel startup sequence:

1. Availability check (`checkPythonKernelAvailability`) — verifies that a Python interpreter resolves and runs.
2. Spawn `python -u runner.py` with filtered env and `cwd`.
3. Send an init request that runs `os.chdir(cwd)`, injects env entries, and adds `cwd` to `sys.path`.
4. Execute `PYTHON_PRELUDE` (idempotent — only initializes once per process).

Kernel shutdown:

- Send `{"type": "exit"}` over stdin.
- Wait for process exit with `SHUTDOWN_GRACE_MS` budget.
- Escalate to `SIGTERM` and finally `SIGKILL` if the process does not exit in time.

## Wire protocol (NDJSON, host ↔ runner)

One JSON object per line, UTF-8, `\n` terminated.

Host → runner:

```jsonc
{"id": "<reqId>", "code": "<source>", "silent": false, "storeHistory": true}
{"type": "exit"}
```

Runner → host:

```jsonc
{"type": "started",  "id": "<reqId>"}
{"type": "stdout",   "id": "<reqId>", "data": "..."}
{"type": "stderr",   "id": "<reqId>", "data": "..."}
{"type": "display",  "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "result",   "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "error",    "id": "<reqId>", "ename": "...", "evalue": "...", "traceback": ["..."]}
{"type": "done",     "id": "<reqId>", "status": "ok"|"error", "executionCount": N, "cancelled": false}
```

Status events the prelude emits (e.g. `_emit_status("find", count=…)`) ship inside display bundles under `application/x-gjc-status` so the existing TUI status renderer keeps working.

## Magics

The runner's source transformer rewrites IPython-style magics to plain Python calls before parsing. Supported set:

| Magic | Effect |
| --- | --- |
| `%pip <args>` | `python -m pip <args>` with live streaming output. Newly installed packages are evicted from `sys.modules` so the next `import` picks up the fresh install. |
| `%cd <path>` | `os.chdir(path)` (with `~` expansion); emits status event. |
| `%pwd` | Returns `os.getcwd()`. |
| `%ls [path]` | Returns `sorted(os.listdir(path))`. |
| `%env [KEY[=VAL]]` | List, read, or set env vars (matches prelude `env()` semantics). |
| `%set_env KEY VALUE` | Set `os.environ[KEY]`. |
| `%time <expr>` / `%timeit <expr>` | Time the expression; emits status event with elapsed ms. |
| `%who` / `%whos` | List user-namespace names. |
| `%reset` | Clear user globals and re-inject prelude. |
| `%load <path>` | Read a file into a fresh cell and execute. |
| `%run <path>` | `runpy.run_path` and merge globals back. |
| `%%bash` / `%%sh` | Run the cell body via `bash`/`sh`. |
| `%%capture [name]` | Run body with stdout/stderr captured into `name`. |
| `%%timeit` | Time the cell body. |
| `%%writefile <path>` | Write body to file. |
| `!cmd` / `var = !cmd` | Run command via subprocess shell; returns an SList-style result with `.n` / `.s` helpers. |
| `var = %name args` | Assignment forms work for line magics and `!cmd`. |

Unknown magic names raise `NameError: UsageError: ...` inside the cell.

## Session persistence semantics

`python.kernelMode` controls retained kernel reuse:

- `session` (default)
  - Reuses kernel sessions keyed by session file plus cwd when a session file exists; otherwise by cwd.
  - Execution is serialized per session via a queue.
  - Idle sessions are evicted after 5 minutes.
  - At most 4 sessions; oldest is evicted on overflow.
  - Heartbeat checks detect dead kernels.
  - Auto-restart allowed once; repeated crash ⇒ hard failure.
- `per-call`
  - Spawns a fresh subprocess for each request.
  - Shuts the subprocess down after the request.
  - No cross-call state persistence.

### Multi-cell behavior in a single tool call

Cells run sequentially in the same kernel instance for that tool call.

If an intermediate cell fails:

- Earlier cell state remains in memory.
- Tool returns a targeted error indicating which cell failed.
- Later cells are not executed.

`reset=true` only applies to the first cell execution in that call.

## Environment filtering and runtime resolution

Environment is filtered before launching the runner:

- Allowlist includes core vars like `PATH`, `HOME`, locale vars, `VIRTUAL_ENV`, `PYTHONPATH`, etc.
- Allow-prefixes: `LC_`, `XDG_`, `GJC_`
- Denylist strips common API keys (OpenAI/Anthropic/Gemini/etc.)

Runtime selection order:

1. Active/located venv (`VIRTUAL_ENV`, then `<cwd>/.venv`, `<cwd>/venv`)
2. Managed venv at `~/.gjc/python-env`
3. `python` or `python3` on PATH

When a venv is selected, its bin/Scripts path is prepended to `PATH`.

The runner additionally receives `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8` so streamed output reaches the host promptly.

## Tool availability and mode selection

`eval.py` / `eval.js` (both default `true`) plus optional `GJC_PY` override controls eval backend exposure:

- Python backend only (`eval.py=true`, `eval.js=false`)
- JavaScript backend only (`eval.py=false`, `eval.js=true`)
- both backends

`GJC_PY` accepted values:

- `0` / `bash` → JavaScript backend only
- `1` / `py` → Python backend only
- `mix` / `both` → both backends

If Python preflight fails and `eval.js` is enabled, `eval` remains available and dispatches to JavaScript unless `language: "python"` is explicitly requested.

## Execution flow and cancellation/timeout

### Tool-level timeout

`eval` timeout is in seconds, default 30, clamped to `1..600`. The tool combines caller abort signal and timeout signal with `AbortSignal.any(...)`.

### Kernel execution cancellation

On abort/timeout:

- The host sends `kill("SIGINT")` to the runner subprocess.
- The runner's exec-time signal handler raises `KeyboardInterrupt` inside the user code.
- Result includes `cancelled=true`; timeout path annotates output as `Command timed out after <n> seconds`.
- Between requests the runner installs `SIG_IGN` for SIGINT so a stray cancel does not tear down the kernel.

If a second cancel is required (runner stuck in C code), the host escalates to `SIGTERM` and the session restarts on the next call.

### stdin behavior

Interactive stdin is not supported. The runner does not forward `input()` prompts; user code that calls `input()` blocks until cancellation.

## Output capture and rendering

### Captured output classes

From runner frames:

- `stdout` / `stderr` → plain text chunks
- `display` / `result` → rich display handling (MIME bundle)
- `error` → traceback text
- `application/x-gjc-status` MIME inside `display` → structured status events

Display MIME precedence:

1. `text/markdown`
2. `text/plain`
3. `text/html` (converted to basic markdown)

Additionally captured as structured outputs:

- `application/json` → JSON tree data
- `image/png` / `image/jpeg` → image payloads
- `application/x-gjc-status` → status events

### Matplotlib

The runner sets `MPLBACKEND=Agg` as an environ default so figures render off-screen. After every cell, `pyplot.get_fignums()` is iterated; each figure is saved to PNG, emitted as an `image/png` display, and closed.

### Storage and truncation

Output is streamed through `OutputSink` and may be persisted to artifact storage. Tool results can include truncation metadata and `artifact://<id>` for full output recovery.

### Renderer behavior

- Tool renderer (`eval.ts`):
  - shows code-cell blocks with per-cell status
  - collapsed preview defaults to 10 lines
  - supports expanded mode for full output and richer status detail
- Interactive renderer (`eval-execution.ts`):
  - used for user-triggered Python execution in TUI
  - collapsed preview defaults to 20 lines
  - clamps very long individual lines to 4000 chars for display safety
  - shows cancellation/error/truncation notices

## Operational troubleshooting

- **Python backend not available** — Check `eval.py`, `GJC_PY`, and that `python`/`python3` is on PATH. If preflight fails and `eval.js` is enabled, omit `language` or pass `language: "js"` to use JavaScript.
- **No Python on PATH** — Install a system Python 3.8+ or place a venv at `~/.gjc/python-env`. `gjc setup python --check` reports the resolved interpreter.
- **Execution hangs then times out** — Increase tool `timeout` (max 600s) if workload is legitimate. For stuck native code, cancellation triggers `SIGINT` first then escalates; the session restarts on the next request.
- **stdin/input prompts in Python code** — `input()` is not supported; pass data programmatically.
- **Working directory errors** — Tool validates `cwd` exists and is a directory before execution.

## Relevant environment variables

- `GJC_PY` — tool exposure override
- `GJC_PYTHON_SKIP_CHECK=1` — bypass Python preflight/warm checks
- `GJC_PYTHON_INTEGRATION=1` — enable gated integration tests that spawn a real Python
- `GJC_PYTHON_IPC_TRACE=1` — log NDJSON frames exchanged with the runner subprocess
