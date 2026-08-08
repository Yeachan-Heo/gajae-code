# ACP local development

How to run a source change through a real ACP client on your machine. The
protocol contract lives in [External control readiness](./external-control-readiness.md);
this page is only the build/run/verify loop.

The commands below assume macOS or Linux with a POSIX shell. The Paseo examples
were verified with Paseo 0.2.5; confirm command and status names when using a
newer release.

## The loop

```sh
bun run build:native        # only when crates/ changed
bun run install:dev:bin     # compile dist/gjc and point `gjc` on PATH at it
bun run restart:sdk-broker -- --close-session-hosts  # REQUIRED — see below
```

Then drive it from a client, or from a bare stdio handshake:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true}}}' | gjc acp
```

## Why the broker restart is not optional

`gjc acp` is a thin stdio front end. It does not run the agent loop — it attaches
to the SDK broker published for the agent directory, and the broker spawns a
`sdk session-host-internal` child per session. That broker is long-lived and
holds the entrypoint it was started from, so **rebuilding the binary changes
nothing for ACP until the broker is replaced**: the new `gjc acp` process talks
to an old broker, which spawns session hosts from the old build, and your change
appears to have no effect.

The symptom is indistinguishable from a broken fix. Check the broker's
entrypoint before concluding anything about a change:

```sh
ps -eo pid,etime,command | grep '[b]roker-internal'
```

A stale broker is obvious once you look — the path is a different checkout, or
the elapsed time predates your build:

```
19466  08:25:00  /Users/you/git/gajae-code/packages/coding-agent/dist/gjc sdk broker-internal --agent-dir /Users/you/.gjc/agent
```

After `bun run restart:sdk-broker -- --close-session-hosts` from your checkout,
the broker is replaced by one running that checkout's source:

```
79955  00:09  bun --config=.../src/sdk/broker/internal-source.bunfig.toml .../src/cli.ts sdk broker-internal --agent-dir /Users/you/.gjc/agent
```

The restart asks the published broker to shut down over its authenticated
loopback channel and starts a replacement. `--close-session-hosts` first closes
every broker-spawned host in that agent directory, so it can interrupt active
ACP work; it never closes interactive `gjc` TUI sessions. Without the flag,
live hosts keep their old entrypoint. A broker-only restart is safe only when
you will create a fresh ACP session instead of loading or reusing an existing
one.

Working against a scratch agent directory instead:

```sh
bun run restart:sdk-broker -- --agent-dir /tmp/gjc-acp-agent --close-session-hosts
GJC_CODING_AGENT_DIR=/tmp/gjc-acp-agent gjc acp
```

A fresh agent directory carries no credentials. Stored local credentials live
in `agent.db`, not `models.db`; do not copy a live SQLite database. Authenticate
inside the scratch agent directory, use provider environment variables or an
auth broker, or copy `agent.db` only while no process is using either database.
For Paseo, put `GJC_CODING_AGENT_DIR` in the provider's `env` entry and restart
the Paseo daemon, or pass it with `paseo run --env` so the provider process
receives the override.

## Confirming what is actually live

| Question | Command |
|---|---|
| Which binary is `gjc`? | `readlink $(which gjc)` |
| When was it built? | `ls -l packages/coding-agent/dist/gjc` |
| Which broker is serving? | `ps -eo pid,etime,command \| grep '[b]roker-internal'` |
| Which hosts are running? | `ps -eo pid,etime,command \| grep 'session-host-internal'` |

`bun run install:dev:bin` prints the symlink it wrote and runs a smoke test, so
its output already answers the first question.

## Driving it from Paseo

Register GJC as a custom ACP provider in `~/.paseo/config.json` (full example in
[External control readiness](./external-control-readiness.md#paseo-custom-agent)),
then:

```sh
paseo daemon restart              # after editing config.json
paseo provider ls                 # gjc must read `available`, not `error`
paseo run --provider gjc --cwd /tmp/gjc-acp-test --wait-timeout 3m "your prompt"
paseo logs <agent-id>             # rendered transcript
paseo ls                          # lifecycle: running / idle / error
paseo stop <agent-id>             # exercises session/cancel
paseo delete <agent-id>
```

Paseo runs its daemon as a separate long-lived process, so it needs its own
restart after a config change — but not after a GJC rebuild, since it spawns
`gjc` per session. `--wait-timeout 3m` stops the CLI from waiting; it does not
cancel the agent, which may remain `running`. That timeout is separate from
GJC's `sdk.promptDeadlineMs`, which defaults to 30 minutes and settles as
`prompt_deadline_exceeded`.

Errors surface in the daemon log with the JSON-RPC payload intact, which is
where to look when the CLI prints something opaque like
`Failed to create agent: [object Object]`:

```sh
grep -i 'failed to create agent' ~/.paseo/daemon.log | tail -1
```

## What to smoke-test

Unit tests cover the individual terminal and cancellation contracts, but not
the complete client/daemon/process lifecycle. At minimum:

- **A configured continuation path.** Exercise a deterministic todo reminder,
  TTSR resume, or auto-continue setup and verify that the same `session/prompt`
  eventually settles instead of remaining `running`. Different continuation
  mechanisms may start another agent run or continue within a managed loop, so
  do not use a fixed `agent_start` count as the invariant.
- **A follow-up turn on the same session**, including a tool call that touches
  the filesystem.
- **Cancel mid-turn.** The pending prompt must settle as `cancelled`, and the
  agent must land on `idle` rather than surfacing a transport error.
- **A non-default mode**, if the client offers one.
- **`initialize`** against the bare stdio handshake above, to eyeball the
  advertised capabilities.

## Verification references

- `packages/coding-agent/test/acp-*.test.ts`
- `packages/coding-agent/test/acp/`
- `packages/coding-agent/test/sdk-acp-*.test.ts`
- `bun run conformance:run` — pinned `acp-core-v1` corpus
