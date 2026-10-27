Provides debugger access through the Debug Adapter Protocol (DAP).
Use for launching or attaching debuggers, setting breakpoints, stepping through execution, inspecting threads/stack/variables, evaluating expressions, capturing output, and interrupting hung programs.

<instruction>
- Prefer over bash for program state, breakpoints, stepping, thread inspection, or interrupting a running process.
- `action: "launch"` starts a session; `program` is required, `adapter` optional (auto-selected from target path and workspace).
  For Python, set `adapter: "debugpy"` and `program` to the target `.py` file; put interpreter/script flags in `args`.
- `action: "attach"` connects to an existing process: `pid` for local attach, `port` for remote attach (where the adapter supports it), `adapter` to force a specific debugger.
- **Breakpoints**: `set_breakpoint`/`remove_breakpoint` with source (`file`+`line`) or function (`function`); optional `condition` for conditional breakpoints.
- **Flow control**: `continue` (resumes; briefly waits to observe whether the program stops or keeps running), `step_over`/`step_in`/`step_out` (single-step), `pause` (interrupt a running program so you can inspect state).
- **Inspect**: `threads` (list), `stack_trace` (frames for current stopped thread), `scopes` (needs `frame_id` or a current stopped frame), `variables` (needs `variable_ref` or `scope_id`), `evaluate` (needs `expression`; `context: "repl"` for raw debugger commands when the adapter supports them), `output` (captured stdout/stderr/console), `sessions` (tracked debug sessions), `terminate`.
- Timeouts apply per-request, not to the full session lifetime.
</instruction>

<caution>
- Only one active debug session is supported at a time.
- Some adapters require a launched session to receive `configurationDone` before the target actually runs; if the tool says configuration is pending, set breakpoints and then call `continue`.
- Adapter availability depends on local binaries. Common built-ins: `gdb`, `lldb-dap`, `python -I -m debugpy.adapter`, `dlv dap`.
- `program` must be an executable file or debug target, not a directory or interpreter name that resolves to a workspace directory.
</caution>

<examples>
# Launch and inspect hang
1. `debug(action: "launch", program: "./my_app")`
2. `debug(action: "set_breakpoint", file: "src/main.c", line: 42)`
3. `debug(action: "continue")`
4. If the program appears hung: `debug(action: "pause")`
5. Inspect state with `threads`, `stack_trace`, `scopes`, and `variables`
# Launch a Python script with debugpy
`debug(action: "launch", adapter: "debugpy", program: "scripts/job.py", args: ["--flag"])`
# Raw debugger command through repl
`debug(action: "evaluate", expression: "info registers", context: "repl")`
</examples>
