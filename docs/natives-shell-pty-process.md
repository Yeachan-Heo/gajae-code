# Natives Shell, PTY, Process, and Key Internals

This document covers the execution/process/terminal primitives in `@gajae-code/natives`: `shell`, `pty`, `ps`, and `keys`, using the architecture terms from `docs/natives-architecture.md`.

## Implementation files

- `crates/pi-natives/src/shell.rs`
- `crates/pi-shell/src/windows.rs` (Windows-only PATH enrichment)
- `crates/pi-natives/src/pty.rs`
- `crates/pi-natives/src/ps.rs`
- `crates/pi-natives/src/keys.rs`
- `crates/pi-natives/src/task.rs`
- `packages/natives/native/index.d.ts`

## Layer ownership

- **Package entrypoint** (`packages/natives/native/index.js`): loads the `.node` addon and exports generated N-API bindings.
- **Rust N-API module layer** (`crates/pi-natives/src/*`): shell/PTY process execution, process-tree traversal/termination, and key-sequence parsing.
- **Consumers** (`packages/coding-agent`, `packages/tui`): higher-level session policy, output artifact/minimizer handling, render policy, and UI key handling.

## Shell subsystem (`shell`)

### API model

Two execution modes are exposed:

1. **One-shot** via `executeShell(options, onChunk?)`.
2. **Persistent session** via `new Shell(options?)` then `shell.run(...)` repeatedly.

Both stream output through a threadsafe callback and return `{ exitCode?, cancelled, timedOut, minimized? }`.

`ShellOptions` supports `sessionEnv`, `snapshotPath`, and optional output `minimizer`. `ShellExecuteOptions` supports command-scoped `env`, session-level `sessionEnv`, `snapshotPath`, timeout/signal, and optional minimizer. `ShellRunOptions` supports command, cwd, command-scoped env, timeout, and signal.

### Session creation and environment model

Rust creates `brush_core::Shell` with:

- non-interactive, non-login mode,
- `no_profile` and `no_rc`,
- `do_not_inherit_env: true`,
- bash-mode builtins, with `exec` and `suspend` disabled,
- explicit environment reconstruction from host env,
- skip-list for shell-sensitive vars (`PS1`, `PWD`, `SHLVL`, bash function exports, etc.).

Session env behavior:

- `ShellOptions.sessionEnv` / one-shot `sessionEnv` is applied at session creation.
- `ShellRunOptions.env` / one-shot `env` is command-scoped (`EnvironmentScope::Command`) and popped after the command.
- `PATH` is merged specially on Windows with case-insensitive dedupe.
- Windows-only path enrichment (`shell/windows.rs`) appends discovered Git-for-Windows paths when present and not already included.
- `snapshotPath`, when present, is sourced during session creation with stdout/stderr/stdin wired to null files.

### Runtime lifecycle and state transitions

Persistent shell (`Shell.run`) uses this state machine:

- **Idle/Uninitialized**: `session: None`.
- **Running**: first `run()` lazily creates a session, stores an abort token, executes command.
- **Completed + keepalive**: if execution control flow is normal, abort state is cleared and session is reused.
- **Completed + teardown**: if control flow is loop/script/shell-exit related, session is dropped.
- **Cancelled/Timed out**: run task is cancelled, grace wait is 2 seconds, task may be force-aborted, session is dropped if lock can be acquired.
- **Error**: session is dropped.

One-shot shell (`executeShell`) always creates and drops a fresh session per call.

### Streaming/output and minimizer behavior

- Stdout/stderr are routed into a shared pipe and read concurrently.
- Reader decodes UTF-8 incrementally; invalid byte sequences emit `U+FFFD` replacement chunks.
- The command runs in a new process group policy.
- Optional minimizer configuration can capture and rewrite output. When minimization occurs, the result includes `minimized` with filter name, replacement text, original text, and byte counts.
- Consumers are responsible for persisting or displaying minimizer artifacts; the native result only carries the data.

### Cancellation, timeout, and abort

- `CancelToken` is constructed from `timeoutMs` and optional `AbortSignal`.
- On cancellation/timeout, shell cancellation token is triggered, then task gets a 2-second graceful window before forced abort.
- Structured result flags are used:
  - timeout -> `exitCode` omitted, `timedOut: true`.
  - abort signal / `Shell.abort()` -> `exitCode` omitted, `cancelled: true`.

`Shell.abort()` behavior:

- aborts the current running command for that `Shell` instance through the stored `AbortToken`,
- resolves successfully even when nothing is running.

### Failure behavior

Common surfaced errors include:

- session init failures (`Failed to initialize shell`),
- cwd errors (`Failed to set cwd`),
- env set/pop failures,
- snapshot source failures (`Failed to source snapshot`),
- pipe creation/clone failures,
- execution failure (`Shell execution failed: ...`),
- task wrapper failures (`Shell execution task failed: ...`).

## PTY subsystem (`pty`)

### API model

`new PtySession()` exposes:

- `start(options, onChunk?) -> Promise<{ exitCode?, cancelled, timedOut }>`
- `write(data)`
- `resize(cols, rows)`
- `kill()`

`PtyStartOptions` supports `command`, optional `cwd`, optional `env`, `timeoutMs`, `signal`, `cols`, and `rows`.

### Runtime lifecycle and state transitions

`PtySession` state machine:

- **Idle**: `core: None`.
- **Reserved**: `start()` installs control channel synchronously (`core: Some`) before async work begins, so `write/resize/kill` become immediately valid.
- **Running**: blocking PTY loop handles child state, reader events, cancellation heartbeat, and control messages.
- **Terminal closed / drain**: child exit or cancellation starts a short reader drain window.
- **Finalized**: `core` is always reset to `None` after start task completion (success or error).

Concurrency guard:

- starting while already running returns `PTY session already running`.

### Spawn/attach/write/read/terminate patterns

- PTY opened via `portable_pty::native_pty_system().openpty(...)`.
- Command currently runs as `sh -lc <command>` with optional `cwd` and env overrides.
- Default size is `120x40`; dimensions are clamped (`cols 20..400`, `rows 5..200`).
- `write()` sends raw bytes to PTY stdin.
- `resize()` sends a control message and clamps dimensions again.
- `kill()` sends a control message that marks the run cancelled and terminates the child/process tree.

Output path:

- dedicated reader thread reads master stream,
- incremental UTF-8 decode emits `U+FFFD` for invalid bytes,
- chunks forwarded through N-API threadsafe callback.

Termination path:

- Unix: terminate process group when known, terminate child tree, call child kill, then repeat with SIGKILL.
- Non-Unix: terminate child tree, call child kill, then repeat with SIGKILL-equivalent process-tree helper.

### Cancellation and timeout semantics

- `timeoutMs` and `AbortSignal` feed a `CancelToken`.
- Loop calls `ct.heartbeat()` periodically with a 16ms maximum wait cadence.
- Timeout classification is based on the heartbeat error string containing `Timeout`.
- Cancellation/kill starts a 300ms post-cancel drain window; normal child exit starts a 300ms post-exit drain window.

### Failure behavior

Error surfaces include:

- PTY allocation/open failure,
- PTY spawn failure,
- writer/reader acquisition failure,
- child status/wait failures,
- lock poisoning,
- control-channel disconnection (`PTY session is no longer available`).

Control call failures when not running:

- `write/resize/kill` return `PTY session is not running`.

## Process-tree subsystem (`ps`)

### API model

- `killTree(pid, signal) -> number`
- `listDescendants(pid) -> number[]`

### Platform-specific implementation

- **Linux**: recursively reads `/proc/<pid>/task/<pid>/children`.
- **macOS**: uses `libproc` `proc_listchildpids`.
- **Windows**: snapshots process table with `CreateToolhelp32Snapshot`, builds parent->children map, terminates with `OpenProcess(PROCESS_TERMINATE)` + `TerminateProcess`.

### Kill-tree behavior

- Descendants are collected recursively.
- Kill order is bottom-up (deepest descendants first).
- Root pid is killed last.
- Return value is count of successful terminations.

Signal behavior:

- POSIX: provided `signal` is passed to `kill`.
- Windows: `signal` is ignored; termination is unconditional process terminate.

### Failure behavior

This module is intentionally non-throwing at API surface for ordinary process misses:

- missing/inaccessible process tree branches are skipped,
- per-pid kill failures are counted as unsuccessful,
- lookup miss typically yields `[]` from `listDescendants` and `0` from `killTree`.

## Key parsing subsystem (`keys`)

### API model

Exposed helpers:

- `parseKey(data, kittyProtocolActive)`
- `matchesKey(data, keyId, kittyProtocolActive)`
- `parseKittySequence(data)`
- `matchesKittySequence(data, expectedCodepoint, expectedModifier)`
- `matchesLegacySequence(data, keyName)`

### Parsing model

The parser combines:

- direct single-byte mappings (`enter`, `tab`, `ctrl+<letter>`, printable ASCII),
- O(1) legacy escape-sequence lookup (PHF map),
- xterm `modifyOtherKeys` parsing,
- Kitty protocol parsing (`CSI u`, `CSI ~`, `CSI 1;...<letter>`),
- normalization to key IDs (`ctrl+c`, `shift+tab`, `pageUp`, `f5`, etc.).

Modifier handling:

- only shift/alt/ctrl bits are compared for key matching,
- lock bits are masked out before comparisons.

Layout behavior:

- base-layout fallback is intentionally constrained so remapped layouts do not create false matches for ASCII letters/symbols.

### Failure behavior

- Unrecognized or invalid sequences produce `null` from parse functions.
- Match functions return `false` on parse failure or mismatch.
- No thrown error surface for malformed key input.

## JS API ↔ Rust export mapping

### Shell + PTY + Process

| JS API                            | Rust N-API export                      | Notes                                     |
| --------------------------------- | -------------------------------------- | ----------------------------------------- |
| `executeShell(options, onChunk?)` | `executeShell` (`execute_shell`)       | One-shot shell execution                  |
| `new Shell(options?)`             | `Shell` class                          | Persistent shell session                  |
| `shell.run(options, onChunk?)`    | `Shell::run`                           | Reuses session on keepalive control flow  |
| `shell.abort()`                   | `Shell::abort`                         | Aborts active run for that shell instance |
| `new PtySession()`                | `PtySession` class                     | Stateful PTY session                      |
| `pty.start(options, onChunk?)`    | `PtySession::start`                    | Interactive PTY run                       |
| `pty.write(data)`                 | `PtySession::write`                    | Raw stdin passthrough                     |
| `pty.resize(cols, rows)`          | `PtySession::resize`                   | Clamped terminal dimensions               |
| `pty.kill()`                      | `PtySession::kill`                     | Force-kills active PTY child              |
| `killTree(pid, signal)`           | `killTree` (`kill_tree`)               | Children-first process tree termination   |
| `listDescendants(pid)`            | `listDescendants` (`list_descendants`) | Recursive descendants listing             |

### Keys

| JS API                                         | Rust N-API export                                   | Notes                           |
| ---------------------------------------------- | --------------------------------------------------- | ------------------------------- |
| `matchesKittySequence(data, cp, mod)`          | `matchesKittySequence` (`matches_kitty_sequence`)   | Kitty codepoint+modifier match  |
| `parseKey(data, kittyProtocolActive)`          | `parseKey` (`parse_key`)                            | Normalized key-id parser        |
| `matchesLegacySequence(data, keyName)`         | `matchesLegacySequence` (`matches_legacy_sequence`) | Exact legacy sequence map check |
| `parseKittySequence(data)`                     | `parseKittySequence` (`parse_kitty_sequence`)       | Structured Kitty parse result   |
| `matchesKey(data, keyId, kittyProtocolActive)` | `matchesKey` (`matches_key`)                        | High-level key matcher          |

## Abandoned session cleanup and finalization notes

- **Shell persistent session**: if a run is cancelled/timed out/errors/non-keepalive control flow, Rust drops the internal session state. Successful normal runs keep the session for reuse.
- **PTY session**: `core` is always cleared after `start()` finishes, including failure paths.
- **No explicit JS finalizer-driven kill contract** is exposed by wrappers; cleanup is primarily tied to run completion/cancellation paths. Callers should use `timeoutMs`, `AbortSignal`, `shell.abort()`, or `pty.kill()` for deterministic teardown.
