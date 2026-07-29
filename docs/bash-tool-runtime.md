# Bash tool runtime

This document describes the **`bash` tool** runtime path used by agent tool calls, from command normalization to execution, truncation/artifacts, and rendering.

It also calls out where behavior diverges in interactive TUI, print mode, ACP, and user-initiated bang (`!`) shell execution.

## Scope and runtime surfaces

There are two different bash execution surfaces in coding-agent:

1. **Tool-call surface** (`toolName: "bash"`): used when the model calls the bash tool.
   - Entry point: `BashTool.execute()`.
   - Parameters include `command`, optional `env`, `timeout`, `cwd`, `pty`, and, when `async.enabled` is true, `async`.
2. **User bang-command surface** (`!cmd` from interactive input): session-level helper path.
   - Entry point: `AgentSession.executeBash()`.

Both eventually use `executeBash()` in `src/exec/bash-executor.ts` for non-PTY execution, but only the tool-call path runs normalization/interception, optional managed background-job handling, and tool renderer logic.

## End-to-end tool-call pipeline

## 1) Input handling and parameter merge

`BashTool.execute()` currently handles input before execution as follows:

- validates optional `env` names against shell-variable syntax,
- extracts a leading `cd <path> && ...` into `cwd` when `cwd` was not supplied,
- rejects `async: true` when `async.enabled` is false,
- optionally removes harmless trailing `| head ...` / `| tail ...` limiters through `applyBashFixups()` when `bash.stripTrailingHeadTail` is enabled,
- leaves output-window selection to `OutputSink`: a 1 KiB tail by default, an explicitly configured `tools.artifactTailBytes` tail budget, or head+tail when `tools.artifactHeadBytes` is explicitly configured.

## 2) Optional interception (blocked-command path)

If `bashInterceptor.enabled` is true, `BashTool` loads rules from settings and runs `checkBashInterception()` against the normalized command.

Interception behavior:

- command is blocked **only** when:
  - regex rule matches, and
  - the suggested tool is present in `ctx.toolNames`.
- invalid regex rules are silently skipped.
- on block, `BashTool` throws `ToolError` with message:
  - `Blocked: ...`
  - original command included.

Default rule patterns (defined in code) target common misuses:

- file readers (`cat`, `head`, `tail`, ...)
- search tools (`grep`, `rg`, ...)
- file finders (`find`, `fd`, ...)
- in-place editors (`sed -i`, `perl -i`, `awk -i inplace`)
- shell redirection writes (`echo ... > file`, heredoc redirection)

### Caveat

`InterceptionResult` includes `suggestedTool`, but `BashTool` currently surfaces only the message text (no structured suggested-tool field in `details`).

## 3) CWD validation and timeout clamping

`cwd` is resolved relative to session cwd (`resolveToCwd`), then validated via `stat`:

- missing path -> `ToolError("Working directory does not exist: ...")`
- non-directory -> `ToolError("Working directory is not a directory: ...")`

Timeout is clamped to `[1, 3600]` seconds and converted to milliseconds.

## 4) Artifact allocation

Before execution, the tool allocates an artifact path/id (best-effort) for truncated output storage.

- artifact allocation failure is non-fatal (execution continues without artifact spill file),
- artifact id/path are passed into execution path for full-output persistence on truncation.

## 5) PTY vs non-PTY execution selection

`BashTool` chooses PTY execution only when all are true:

- tool input `pty === true`
- `GJC_NO_PTY !== "1"`
- tool context has UI (`ctx.hasUI === true` and `ctx.ui` set)

Otherwise it uses non-interactive `executeBash()`.

That means print mode and non-UI tool contexts always use non-PTY.

## Non-interactive execution engine (`executeBash`)

## Shell session reuse model

`executeBash()` caches native `Shell` instances in a process-global map keyed by:

- shell path,
- configured command prefix,
- snapshot path,
- serialized shell env,
- optional agent session key.

Session-level bang-command executions pass `sessionKey: this.sessionId`.

Tool-call executions pass `sessionKey: this.session.getSessionId?.()`, when available. In both surfaces, a session key isolates shell reuse per session; without one, reuse falls back to shell config/snapshot/env.

## Shell config and snapshot behavior

At each call, executor loads settings shell config (`shell`, `env`, optional `prefix`).

If selected shell includes `bash`, it attempts `getOrCreateSnapshot()`:

- snapshot captures aliases/functions/options from user rc,
- snapshot creation is best-effort,
- failure falls back to no snapshot.

If `prefix` is configured, command becomes:

```text
<prefix> <command>
```

## Streaming and cancellation

`Shell.run()` streams chunks to `OutputSink` and optional `onChunk` callback.

Cancellation:

- aborted signal triggers `shellSession.abort(...)`,
- timeout from native result is mapped to `cancelled: true` + annotation text,
- explicit cancellation similarly returns `cancelled: true` + annotation.

No exception is thrown inside executor for timeout/cancel; it returns structured `BashResult` and lets caller map error semantics.

## Interactive PTY path (`runInteractiveBashPty`)

When PTY is enabled, tool runs `runInteractiveBashPty()` which opens an overlay console component and drives a native `PtySession`.

Behavior highlights:

- xterm-headless virtual terminal renders viewport in overlay,
- keyboard input is normalized (including Kitty sequences and application cursor mode handling),
- `esc` while running kills the PTY session,
- terminal resize propagates to PTY (`session.resize(cols, rows)`).

Environment hardening defaults are injected for unattended runs:

- pagers disabled (`PAGER=cat`, `GIT_PAGER=cat`, etc.),
- editor prompts disabled (`GIT_EDITOR=true`, `EDITOR=true`, ...),
- terminal/auth prompts reduced (`GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS=/usr/bin/false`, `CI=1`),
- package-manager/tool automation flags for non-interactive behavior.

PTY output is normalized (`CRLF`/`CR` to `LF`, `sanitizeText`) and written into `OutputSink`, including artifact spill support.

On PTY startup/runtime error, sink receives `PTY error: ...` line and command finalizes with undefined exit code.

## Output handling: streaming, truncation, artifact spill

Both PTY and non-PTY paths use `OutputSink`.

## OutputSink semantics

- keeps a small in-memory UTF-8-safe tail buffer (1 KiB by default),
- uses an explicitly configured `tools.artifactTailBytes` value to set the Bash tail budget,
- retains no head window by default; explicitly configuring `tools.artifactHeadBytes` opts Bash into head+tail middle elision,
- tracks total bytes/lines seen,
- if an artifact path exists and output overflows (or the file is already active), writes the stream up to the artifact hard cap; any omitted bytes are counted and disclosed instead of calling the artifact complete,
- when memory threshold overflows, trims the in-memory buffer to the tail (UTF-8 boundary safe),
- marks `truncated` when overflow/file spill occurs.

`dump()` returns:

- `output` (possibly annotated prefix),
- `truncated`,
- `totalLines/totalBytes`,
- `outputLines/outputBytes`,
- `artifactId` if artifact file was active.
- `artifactTruncatedBytes` when the artifact hard cap omitted bytes.

### Long-output caveat

`BashTool` supplies a 1 KiB byte threshold to `OutputSink` by default, overridden by an explicit `tools.artifactTailBytes` setting. Direct user bang commands continue to use the executor's shared 50 KiB tail plus configured head window. Neither path enforces a hard line-count cap.

## Live tool updates and async jobs

Foreground streamed updates, PTY capture, managed async jobs, and monitor jobs all use the Bash retention policy resolved from the active `ToolSession`: a 1 KiB UTF-8-safe tail by default, an explicit `tools.artifactTailBytes` tail budget, and optional `tools.artifactHeadBytes` head retention for final captured output. Foreground, async, and monitor progress callbacks use bounded tail previews; PTY live rendering remains in the custom overlay while its final capture uses the same `OutputSink` budgets.

When `async.enabled` is true and the call passes `async: true`, `BashTool` starts a managed Bash job, returns a running job result with a job id, and stores bounded completion output through the session managed-job path. Auto-backgrounding can start the same path after `bash.autoBackground.thresholdMs`.

### ACP client-terminal retention

When the connected client owns terminal execution, GJC requests the same bounded Bash output contract through `outputByteLimit`:

- the default request retains the last 1 KiB; ACP truncates from the beginning at a UTF-8 character boundary,
- an explicit `tools.artifactTailBytes` value sets that requested tail limit,
- an explicit `tools.artifactHeadBytes` value omits the client-side byte limit so GJC can receive the complete returned stream, apply local head+tail middle elision, and save the full returned output when artifact storage is available,
- if the client itself reports `truncated: true`, the returned bytes are already incomplete and GJC does not label an artifact made from that partial value as the full capture,
- poll updates and timeout output use the same local retention policy; a complete oversized timeout capture is saved before the bounded error is surfaced when artifact storage is available.

For an ACP result where the client reports `truncated: true`, a truncation notice without an `artifact://` link means GJC never received the full stream. Separately, when artifact allocation is unavailable, a complete local capture can remain without a link or diagnostic because SDK allocation wrappers may return an empty value; if an artifact writer/save operation is attempted and fails, it emits a bounded diagnostic without inventing an artifact URI.

## Result shaping, metadata, and error mapping

After execution:

1. `cancelled` handling:
   - if abort signal is aborted -> throw `ToolAbortError` (abort semantics),
   - else -> throw `ToolError` (treated as tool failure).
2. PTY `timedOut` -> throw `ToolError`.
3. retain only the final 1 KiB output window by default (or use explicit `tools.artifactTailBytes` / `tools.artifactHeadBytes` retention budgets).
4. empty output becomes `(no output)`.
5. attach truncation metadata via `toolResult(...).truncationFromSummary(result, { direction: "tail" })`.
6. exit-code mapping:
   - missing exit code -> `ToolError("... missing exit status")`
   - non-zero exit -> `ToolError("... Command exited with code N")`
   - zero exit -> success result.

Success payload structure:

- `content`: text output,
- `details.meta.truncation` when truncated, including:
  - `direction`, `truncatedBy`, total/output line+byte counts,
  - `shownRange`,
  - `artifactId` when available.

Because built-in tools are wrapped with `wrapToolWithMetaNotice()`, truncation notice text is appended to final text content automatically; when truncation metadata includes an artifact reference, that notice can include an example such as `Full: artifact://<id>`.

## Rendering paths

## Tool-call renderer (`bashToolRenderer`)

`bashToolRenderer` is used for tool-call messages (`toolCall` / `toolResult`):

- collapsed mode shows visual-line-truncated preview,
- expanded mode shows all currently available output text,
- warning line includes the truncation reason and, when metadata has one, its `artifact://<id>` reference,
- timeout value (from args) is shown in footer metadata line.

### Caveat: full artifact expansion

`BashRenderContext` has `isFullOutput`, but current renderer context builder does not set it for bash tool results. Expanded view still uses the text already in result content (tail/truncated output) unless another caller provides full artifact content.

## User bang-command component (`BashExecutionComponent`)

`BashExecutionComponent` is for user `!` commands in interactive mode (not model tool calls):

- streams chunks live,
- collapsed preview keeps last 20 logical lines,
- line clamp at 4000 chars per line,
- shows truncation + artifact warnings when metadata is present,
- marks cancelled/error/exit state separately.

This component is wired by `CommandController.handleBashCommand()` and fed from `AgentSession.executeBash()`.

## Mode-specific behavior differences

| Surface                        | Entry path                                            | PTY eligible                                                         | Live output UX                                                           | Error surfacing                                  |
| ------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| Interactive tool call          | `BashTool.execute`                                    | Yes, when `pty=true` and UI exists and `GJC_NO_PTY!=1`                | PTY overlay (interactive) or streamed tail updates                       | Tool errors become `toolResult.isError`          |
| Print mode tool call           | `BashTool.execute`                                    | No (no UI context)                                                   | No TUI overlay; output appears in event stream/final assistant text flow | Same tool error mapping                          |
| ACP tool call (agent tooling)  | `BashTool.execute`                                    | Usually no UI -> non-PTY                                             | Structured protocol events/results                                      | Same tool error mapping                          |
| Interactive bang command (`!`) | `AgentSession.executeBash` + `BashExecutionComponent` | No (uses executor directly)                                          | Dedicated bash execution component                                       | Controller catches exceptions and shows UI error |

## Operational caveats

- Interceptor only blocks commands when suggested tool is currently available in context.
- If artifact allocation/storage is unavailable before a writer/save operation is attempted, truncation still occurs without an `artifact://` back-reference and may have no diagnostic because SDK allocation wrappers can return an empty value. If a writer/save operation is attempted and fails, Bash emits a bounded diagnostic; it never fabricates a reference.
- Shell session cache has no explicit eviction in this module; lifetime is process-scoped.
- PTY and non-PTY timeout surfaces differ:
  - PTY exposes explicit `timedOut` result field,
  - non-PTY maps timeout into `cancelled + annotation` summary.

## Implementation files

- [`src/tools/bash.ts`](../packages/coding-agent/src/tools/bash.ts) — tool entrypoint, input handling/interception, async and PTY/non-PTY selection, result/error mapping, bash tool renderer.
- [`src/tools/bash-command-fixup.ts`](../packages/coding-agent/src/tools/bash-command-fixup.ts) — optional removal of harmless trailing `head`/`tail` limiters before execution.
- [`src/tools/bash-interceptor.ts`](../packages/coding-agent/src/tools/bash-interceptor.ts) — interceptor rule matching and blocked-command messages.
- [`src/exec/bash-executor.ts`](../packages/coding-agent/src/exec/bash-executor.ts) — non-PTY executor, shell session reuse, cancellation wiring, output sink integration.
- [`src/tools/bash-interactive.ts`](../packages/coding-agent/src/tools/bash-interactive.ts) — PTY runtime, overlay UI, input normalization, non-interactive env defaults.
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink`, `TailBuffer`, truncation/artifact spill, and summary metadata.
- [`src/tools/output-meta.ts`](../packages/coding-agent/src/tools/output-meta.ts) — truncation metadata shape + notice injection wrapper.
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — session-level `executeBash`, message recording, abort lifecycle.
- [`src/modes/components/bash-execution.ts`](../packages/coding-agent/src/modes/components/bash-execution.ts) — interactive `!` command execution component.
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts) — wiring for interactive `!` command UI stream/update completion.
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://<id>` resolution.
