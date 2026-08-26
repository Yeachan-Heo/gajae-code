# bash

> Execute a shell command in the session workspace, with optional PTY or background-job handling.

## Source
- Entry: `packages/coding-agent/src/tools/bash.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/bash.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/bash-interactive.ts` — PTY/TUI execution path.
  - `packages/coding-agent/src/tools/bash-interceptor.ts` — blocks tool-better shell patterns.
  - `packages/coding-agent/src/tools/bash-skill-urls.ts` — expands internal URLs to paths.
  - `packages/coding-agent/src/exec/bash-executor.ts` — non-PTY shell execution.
  - `packages/coding-agent/src/session/streaming-output.ts` — tail buffer, truncation, artifact spill.
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — timeout clamp bounds.
  - `packages/coding-agent/src/config/settings-schema.ts` — default interceptor rules.
  - `docs/bash-tool-runtime.md` — deeper executor/runtime notes; use as the companion doc for shell-session internals.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `command` | `string` | Yes | Shell command text to execute. A leading `cd <path> && ...` is rewritten into `cwd` only when `cwd` was omitted. |
| `env` | `Record<string, string>` | No | Extra environment variables. Keys must match `^[A-Za-z_][A-Za-z0-9_]*$` or the tool throws. Values also go through internal-URL expansion. |
| `timeout` | `number` | No | Timeout in seconds. Default `300`; clamped to `1..3600` by `clampTimeout("bash", ...)`. |
| `cwd` | `string` | No | Working directory, resolved against `session.cwd` via `resolveToCwd`. Must exist and be a directory. |
| `pty` | `boolean` | No | Request PTY mode. Default `false`. PTY is used only when `pty: true`, `GJC_NO_PTY !== "1"`, and the tool context has a UI. |
| `async` | `boolean` | No | Background execution request. Present only when `async.enabled` is true for the session. Returns immediately with a job id instead of waiting. |

## Outputs
The tool returns a single `text` content block plus optional `details`.

- Success, foreground:
  - `content[0].text`: command output, or `(no output)` when the command produced nothing.
  - `details.timeoutSeconds`: effective timeout after clamping.
  - `details.requestedTimeoutSeconds`: only present when the requested timeout was clamped.
  - `details.meta.truncation`: present when output was truncated in memory; includes `artifactId` when full output spilled to an artifact.
- Success, background start (`async: true` or auto-background):
  - `content[0].text`: optional preview tail, timeout notice if any, then `Background job <id> started: <label>` with follow-up instructions.
  - `details.async`: `{ state: "running", jobId, type: "bash" }`.
- Background progress / completion:
  - delivered through `onUpdate` / async job manager, not the initial return.
  - running updates contain tail text and `details.async.state: "running"` only after the job is considered backgrounded.
  - completion/failure updates carry final text and `details.async.state: "completed" | "failed"`.
- Failure:
  - the tool throws `ToolError` / `ToolAbortError`; non-zero exits are surfaced as errors, not success results.

Stdout and stderr are merged before the model sees them. Non-zero exit codes are appended to the thrown error text as `Command exited with code <n>`.

## Flow
1. `BashTool.execute()` in `packages/coding-agent/src/tools/bash.ts` reads `command`, normalizes `env`, and defaults `timeout` to `300`.
2. If `cwd` is absent, it rewrites a leading `cd <path> && ...` into the structured `cwd` field and strips that prefix from `command`.
3. If `async: true` is requested while `async.enabled` is off, it throws `ToolError` before any execution.
4. If `bashInterceptor.enabled` is on, `checkBashInterception()` runs against both the original command and the `cd`-stripped command. A matching enabled rule throws before URL expansion or execution.
5. `expandInternalUrls()` rewrites supported internal URLs inside `command`, each `env` value, and protocol-looking `cwd` values. Command/env replacements are shell-escaped unless `noEscape` is requested by the caller path.
6. `resolveToCwd()` resolves `cwd` against `session.cwd`; `fs.stat()` verifies that the target exists and is a directory.
7. `clampTimeout("bash", requestedTimeoutSec)` enforces `TOOL_TIMEOUTS.bash` (`default: 300`, `min: 1`, `max: 3600`). When clamped, `#buildCompletedResult()` / `#buildBackgroundStartResult()` append a notice line.
8. Execution path splits:
   1. `async: true` -> `#startManagedBashJob()` registers a session async job and returns immediately.
   2. Non-PTY with `bash.autoBackground.enabled` and an async job manager -> starts a managed job, waits up to `min(thresholdMs, timeoutMs - 1000)`, and either returns the completed result or converts the run into a background job.
   3. Foreground non-PTY, ACP client-terminal, and PTY waits are manager-backed when async support is available, so the fold chord can transfer ownership without restarting the command; otherwise they remain ordinary foreground waits.
9. Foreground non-PTY calls `executeBash()` from `packages/coding-agent/src/exec/bash-executor.ts`.
10. Foreground PTY calls `runInteractiveBashPty()` from `packages/coding-agent/src/tools/bash-interactive.ts`.
11. Both paths allocate an output artifact first when `session.allocateOutputArtifact` is available. The artifact path/id are passed into the sink so large output can spill to disk.
12. `executeBash()` loads shell settings, optional shell snapshot, and shell minimizer settings, then runs via a persistent native `Shell` session or one-shot `executeShell()`. `docs/bash-tool-runtime.md` covers that path in detail.
13. `runInteractiveBashPty()` creates a `PtySession`, overlays an xterm-backed console UI, forwards user key input into the PTY, captures output through `OutputSink`, and keeps the PTY owned by the manager when its observer folds. Escape explicitly kills; disposal alone never kills folded work.
14. On completion, `#buildCompletedResult()` formats `(no output)` when needed, attaches truncation metadata from the `OutputSink` summary, and re-checks exit status / timeout / cancellation before returning.
15. On non-zero exit, timeout, missing exit status, or cancellation, `#buildResultText()` throws with the captured output included in the error message.

## Modes / Variants
1. Foreground non-PTY
   - Default path.
   - Uses `executeBash()`.
   - Streams tail-only updates through `streamTailUpdates()` and `TailBuffer(DEFAULT_MAX_BYTES)`.
2. Foreground PTY
   - Requires `pty: true`, UI context, and `GJC_NO_PTY !== "1"`.
   - Uses `runInteractiveBashPty()` and a `PtySession` overlay; observer disposal is non-owning, while Escape or `job cancel` kills the session.
   - Supports interactive input; `Esc` kills the session from the overlay.
3. Explicit background job
   - Requires `async: true` and `async.enabled`.
   - Registers a job with `session.asyncJobManager` and returns `{ state: "running", jobId }` immediately.
4. Auto-backgrounded non-PTY job
   - Requires `bash.autoBackground.enabled`, no PTY, and an async job manager.
   - Starts like a foreground managed job, then backgrounds it when it outlives the wait window.
5. Intercepted command
   - No subprocess created.

6. Foreground fold
   - The remappable `app.tool.backgroundFold` chord (Alt+Shift+B by default; Cmd+B on macOS) can fold a running managed non-PTY Bash wait, ACP client-terminal wait, or PTY wait into a manager-owned job.
   - The foreground turn stops cleanly after the result boundary; completion wakes a later turn with a receipt containing output, original intent, and a `job` retrieval handle.
   - Folded jobs retain their original deadline and live `job tail` output. PTY observer disposal is non-owning; `job cancel` kills the live PTY through the manager lifecycle.
   - Returns a `ToolError` pointing the model at `read`, `search`, `find`, `edit`, or `write`.

## Side Effects
- Filesystem
  - Validates `cwd` with `fs.stat()`.
  - May allocate and write artifact files for full output (`bash`) and minimizer-preserved raw output (`bash-original`).
  - `expandInternalUrls(..., { ensureLocalParentDirs: true })` creates parent directories for `local://` paths before execution.
- Subprocesses / native bindings
  - Non-PTY uses native shell execution via `@gajae-code/natives` (`Shell.run()` or `executeShell()`).
  - PTY uses native `PtySession.start()`.
- Session state
  - Reads session settings for async, auto-background, interceptor, tool availability, and shell configuration.
  - Registers jobs with `session.asyncJobManager` for explicit/auto background runs.
  - Uses `session.getSessionId()` to isolate shell reuse and async session keys.
  - Uses `session.allocateOutputArtifact()` for spill files.
- User-visible prompts / interactive UI
  - PTY mode opens a TUI overlay titled `Console` and forwards input to the PTY.
  - Background start messages direct the agent to the `job` tool (use `list: true` for a snapshot, or pass `poll: [id]` to wait).
- Background work / cancellation
  - Async and auto-background jobs continue after the initial tool return.
  - Cancellation aborts the native run; Escape and `job cancel` kill a PTY, while overlay disposal alone is non-owning for folded work.

## Limits & Caps
- Default timeout: `300s` (`TOOL_TIMEOUTS.bash.default` in `packages/coding-agent/src/tools/tool-timeouts.ts`).
- Timeout clamp: `1..3600s` (`TOOL_TIMEOUTS.bash.min/max`).
- Auto-background default threshold: `60_000ms` (`DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS` in `packages/coding-agent/src/tools/bash.ts`), further capped to `timeoutMs - 1000` by `#resolveAutoBackgroundWaitMs()`.
- Hard kill grace beyond requested timeout in non-PTY executor: `5_000ms` (`HARD_TIMEOUT_GRACE_MS` in `packages/coding-agent/src/exec/bash-executor.ts`).
- In-memory output tail cap: `50 * 1024` bytes (`DEFAULT_MAX_BYTES` in `packages/coding-agent/src/session/streaming-output.ts`). Once exceeded, the sink keeps only the tail window in memory.
- Streaming callback throttle in `executeBash()`: `50ms` between `onChunk` calls when streaming is enabled.
- TUI collapsed preview: `10` visual lines (`BASH_DEFAULT_PREVIEW_LINES`) when rendered inline in the agent UI; this is a renderer cap, not a tool output cap.

## Errors
- Input validation:
  - invalid env key -> `ToolError("Invalid bash env name: <key>")`.
  - async requested while disabled -> `ToolError("Async bash execution is disabled...")`.
  - missing async job manager -> `ToolError("Async job manager unavailable for this session.")`.
  - missing/bad `cwd` -> `ToolError("Working directory does not exist: ...")` or `ToolError("Working directory is not a directory: ...")`.
- Interceptor:
  - matched command -> `ToolError` with `Blocked: <rule.message>` and the original command.
  - invalid interceptor regexes are silently skipped by `compileRules()`.
- Internal URL expansion:
  - unsupported scheme, unknown skill, path traversal, missing router support, or router resolution failures all throw `ToolError` from `packages/coding-agent/src/tools/bash-skill-urls.ts`.
- Execution:
  - non-zero exit -> thrown `ToolError` containing captured output plus `Command exited with code <n>`.
  - missing exit code -> thrown `ToolError` with `Command failed: missing exit status`.
  - timeout -> thrown `ToolError`; PTY uses `Command timed out after <n> seconds`, non-PTY executor returns cancelled output that `BashTool` converts to an error.
  - user abort -> `ToolAbortError` when the caller signal is aborted.
- Artifact allocation / artifact save failures are swallowed in `saveBashOriginalArtifact()` and `OutputSink.#createFileSink()`; execution continues without that artifact.

## Notes
- `strict = true` and `concurrency = "exclusive"` are set on `BashTool`; the tool does not run concurrently with another bash tool call in the same session.
- `command` and `env` URL expansions shell-escape replacements; `cwd` expansion uses `noEscape: true` because it becomes a filesystem path argument, not shell text.
- `checkBashInterception()` blocks only when the matching rule's `tool` name is present in `ctx.toolNames`; missing tools disable their corresponding rule.
- Default interceptor rules come from `DEFAULT_BASH_INTERCEPTOR_RULES` in `packages/coding-agent/src/config/settings-schema.ts`:
  - `cat|head|tail|less|more` -> `read`
  - `grep|rg|ripgrep|ag|ack` -> `search`
  - `find|fd|locate` with name/type/glob flags -> `find`
  - `sed -i`, `perl -i`, `awk -i inplace` -> `edit`
  - `echo|printf|cat <<` with redirection -> `write`
- PTY mode is ignored in non-UI contexts and when `GJC_NO_PTY=1`; the tool silently falls back to non-PTY execution.
- Non-PTY runs merge `NON_INTERACTIVE_ENV` with `env`; PTY runs also prepend `NON_INTERACTIVE_ENV` before custom env values.
- When the shell minimizer rewrites output inside `executeBash()`, the visible output is replaced with minimized text and a `[raw output: artifact://<id>]` footer may be appended if `onMinimizedSave` persisted the original text.
- The TUI renderer parses partial JSON to recover `env` assignments early in streaming previews; that behavior is display-only.
- For executor internals that are not tool-specific — shell session reuse keys, snapshots, prefix handling, and native timeout behavior — see `docs/bash-tool-runtime.md`.
