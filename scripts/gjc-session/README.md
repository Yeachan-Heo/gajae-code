# GJC session scripts

## Issue #1938 disposable cgroup evidence

The harness creates uniquely named disposable user services, an independent user
scope, and a private `TMUX_TMPDIR`/socket. It never targets the default tmux
namespace, GJC gateway, panes, prompts, runtime payloads, configuration,
environment values, or raw logs.

Run each phase with an opaque session identifier:

```bash
bash scripts/gjc-session/issue-1938-cgroup-repro.sh --phase pre-code --session-id "$GJC_SESSION_ID"
receipt=.gjc/_session-"$GJC_SESSION_ID"/runtime/evidence/issue-1938/pre-code.json
run_nonce="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).run_nonce)' "$receipt")"
bun scripts/gjc-session/validate-issue-1938-evidence.ts "$receipt" "$(git rev-parse HEAD)" "$run_nonce"
```

```bash
bash scripts/gjc-session/issue-1938-cgroup-repro.sh --phase post-code --session-id "$GJC_SESSION_ID"
receipt=.gjc/_session-"$GJC_SESSION_ID"/runtime/evidence/issue-1938/post-code.json
run_nonce="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).run_nonce)' "$receipt")"
bun scripts/gjc-session/validate-issue-1938-evidence.ts "$receipt" "$(git rev-parse HEAD)" "$run_nonce"
```

Pre-code performs a real `systemctl --user restart` of a disposable service that
owns a private tmux server, proves the original owner PID is gone, then proves an
independent disposable user scope survives that unrelated restart and exits after
a direct `SIGTERM`. Post-code exercises the isolated raw and managed product paths.

Linux requires `/proc`, a usable `systemctl --user`, `systemd-run --user`, `tmux`,
and `script` (the approved PTY capability). Missing support writes an
`unsupported` receipt with no cases and exits 77. No PTY field is added to the
receipt capability schema. Failed reproduction exits 1; complete reproduction
exits 0.

The JSON Schema supplies structural and practical conditional constraints. The
executable validator is the semantic authority: it binds a receipt filename phase
to its payload, requires exactly one passed required case per passed phase, and
requires completed cleanup for passed receipts. Receipts contain only public-safe
identifiers, timestamps, process/unit names, cgroups, signals, results, lifecycle
verdicts, dedupe keys, and bounded publication latency. The expected-close path has a
2-second deadline. The unexpected-loss path explicitly runs the normal 5-second raw
monitor interval with a 7-second deadline; three disposable measurements before this
bound was adopted observed canonical verdict/incident publication in 92–158 ms and
current vanished/incident aliases in 5,208–5,288 ms. The executable wait helper records
the actual per-run `latency_ms`, and its deterministic tests cover both timely success
and exact-deadline failure.
