Execute Python in a persistent per-session REPL kernel.

Variables, imports, and loaded data persist across calls in the current GJC session. The kernel runs in the session working directory. Each `execute` call is appended to a JSONL transcript under `$GJC_STATE_DIR/_session-{sessionid}/ipykernels/`; display artifacts are stored under `$GJC_STATE_DIR/_session-{sessionid}/ipykernels/artifacts/`.

## Actions

- `execute` (default) — run `code` in the persistent REPL. Requires `code`.
- `clear` — dispose this session's Python kernel. The next `execute` starts a fresh kernel with no retained state.

## Use

Use this tool for stateful Python work. It is distinct from `eval`: each has a separate kernel and owner, so state is not shared between them.
