Executes bash command in shell session for terminal operations like git, bun, cargo, python.

<instruction>
- Use `cwd` to set working directory, not `cd dir && …`
{{#when restrictionProfile "==" "read-only"}}
- Do not pass `env` overrides or `pty: true`; read-only bash rejects both.
- Shell control operators such as `;`, `|`, `&`, `<`, `>`, and command substitution are blocked.
- Internal URIs (`agent://`, `artifact://`, `rule://`, `local://`) are auto-resolved to filesystem paths without creating parent directories.
{{else}}
- Prefer `env: { NAME: "…" }` for multiline, quote-heavy, or untrusted values; reference as `$NAME`
- Quote variable expansions like `"$NAME"` to preserve exact content
- PTY mode is opt-in: set `pty: true` only when the command needs a real terminal (e.g. `sudo`, `ssh` requiring user input); default is `false`
- Use `;` only when later commands should run regardless of earlier failures
- Internal URIs (`agent://`, `artifact://`, `rule://`, `local://`) are auto-resolved to filesystem paths
{{/when}}
{{#if asyncEnabled}}
- Use `async: true` for long-running commands when you don't need immediate output; the call returns a background job ID and the result is delivered automatically as a follow-up.
{{/if}}
{{#if foregroundFoldEnabled}}
- In the interactive TUI, the user can press the fold chord twice (default `Alt+Shift+B`, plus `Cmd+B` on macOS; remappable via the `app.tool.backgroundFold` keybinding) while a foreground command is still running to fold it into a background job. All three command surfaces fold: managed non-PTY bash, editor/ACP client-terminal commands, and PTY-mode commands. A folded command keeps its original timeout and is never killed or restarted by folding; a folded PTY continues output-only, so it stops accepting input. The turn then ends cleanly and a later turn resumes automatically with the command's result, so the interrupted task is finished rather than abandoned. `task`/`subagent` waits are deliberately NOT foldable. Do not instruct users to use raw shell `Ctrl+Z`/`bg` inside the GJC TUI; ownership and output routing are not safe there.
- A user steer folds the same way: when the user sends a message while a foreground command has already run for at least 2 seconds, the command is folded into a background job and this call returns the background-start result plus the line `Folded into background job <id> because a user steer arrived; the command keeps running with its original timeout and its result will wake a later turn.` The steer is then delivered at this tool boundary, so handle it next; do not re-run the folded command. Steers that arrive within the first 2 seconds let the command finish normally. This applies only while `busyPromptMode` is `steer` and `toolInterruptPolicy` is `abort_tools`.
{{/if}}
</instruction>
{{#if restrictedAllowedPrefixes}}
<restricted-bash-mode>
{{#when restrictionProfile "==" "read-only"}}
This session's bash tool is read-only. It accepts only simple, single-command inspections beginning with:
{{#each restrictedAllowedPrefixes}}
- `{{this}}`
{{/each}}
Shell control operators, command substitution, env overrides, redirects, pipelines, glob expansion, and known write-capable flags are blocked before execution. Use it only when an inspection command is materially better than `read`, `search`, or `find`.
{{else}}
This session's bash tool is restricted. It only accepts commands beginning with:
{{#each restrictedAllowedPrefixes}}
- `{{this}}`
{{/each}}
Use it only for sanctioned GJC workflow CLI persistence or state read/write/contract operations; the only per-command env override allowed is `GJC_RALPLAN_ARTIFACT` when paired with `gjc ralplan --write … --artifact-env GJC_RALPLAN_ARTIFACT`, and all other shell command shapes are blocked before execution.
{{/when}}
</restricted-bash-mode>
{{/if}}

<critical>
{{#when restrictionProfile "==" "read-only"}}
- Use read-only bash only for approved inspection commands that are materially better than dedicated tools; unsafe shell shapes are blocked.
{{else}}
- Use bash only for terminal operations that dedicated tools do not cover.
{{/when}}
- Never pipe through `| head -n N` or `| tail -n N` — output is already truncated. Recover omitted output only when the result includes an `artifact://<id>` footer or metadata reference; truncation without a reference leaves the visible output incomplete with no recoverable artifact.
- Never redirect with `2>&1` or `2>/dev/null` — stdout and stderr are already merged.
</critical>

<output>
- Returns output and exit code.
- Truncated output is recoverable only when the result includes an `artifact://<id>` footer or metadata reference; truncation evidence without such a reference means the visible output is incomplete and no artifact is recoverable.
- Exit codes shown on non-zero exit
</output>

{{#if asyncEnabled}}
# Timeout and async

- `timeout` (seconds) caps the **wall-clock duration** of the command. When it elapses the process is killed and the call returns with a timeout annotation. Range: `1`–`3600`s; default `300`s.
- `async: true` only defers **reporting** of the result — it does NOT disable, extend, or detach the timeout. A daemon started with `async: true` is still killed when `timeout` elapses, regardless of how long the agent waits before reading the result.
- For long-running daemons (dev servers, watchers): either pass an explicit large `timeout` (up to `3600`), or fully detach the process from this shell using `nohup …  &` / `setsid … &` / `disown` so it survives independent of the bash call's lifecycle.
{{/if}}
# Waiting for background work

- A long blocking `sleep N` (or `sleep N && …`) emits nothing for the entire duration and is indistinguishable from a hung session. Never use it to wait for subagents or background jobs.
- To wait for detached task subagents, use `subagent await` — it emits periodic liveness while waiting.
- To wait for background bash jobs, use `job poll` — it reports status on each tick.
- Short sleeps for rate-limiting or pacing (e.g. `sleep 2` between retries) are fine.

# Output minimizer

- Bash stdout/stderr may be rewritten before you see it: long output keeps only the last 1 KiB by default to reduce noise and input-token use. Explicit `tools.artifactTailBytes` / `tools.artifactHeadBytes` settings can set the tail budget or retain both ends. Prefer focused commands and dedicated `search`/`find` tools over producing broad output. Test/lint runners (e.g. `bun test`, `cargo test`, ESLint) are also passed through heuristic filters that drop noise and keep failures.
- When the local minimizer changes visible text, successful artifact storage appends a footer containing an `artifact://<id>` reference. Complete artifacts are labeled as full output; hard-capped artifacts report omitted bytes instead. If artifact allocation/storage is unavailable before a writer/save operation is attempted, truncation may have no reference or diagnostic. If an artifact writer/save operation is attempted and fails, a bounded diagnostic is emitted without inventing an artifact URI.
- ACP/client-terminal output can arrive already truncated from the beginning. Treat any truncation notice or metadata as evidence that the visible tail is incomplete. Recover omitted output only when an `artifact://` footer or metadata reference is present; truncation evidence without a reference means the visible output is incomplete and no artifact is recoverable. Output with neither truncation evidence nor an artifact reference is the complete emitted output.
